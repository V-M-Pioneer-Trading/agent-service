// Starting and stopping the service under test.
//
// The default is `docker run` of the image named by CONTRACT_IMAGE. That is the
// only thing the suite knows about the implementation: an image that listens on
// PORT, reads the environment below, and answers HTTP.
//
// CONTRACT_COMMAND is a fast loop for people porting the service: when set, it is
// run through the shell instead of docker, with the same environment, and the
// stubs are addressed as 127.0.0.1.

import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

export interface StubPorts {
  gateway: number;
  center: number;
  centerSecret: string;
}

export interface ServiceOptions {
  /** Overrides or removals (undefined) applied on top of the default environment. */
  env?: Record<string, string | undefined>;
}

export interface RunningService {
  baseUrl: string;
  /** Everything the service printed so far. */
  logs(): Promise<string>;
  stop(): Promise<void>;
}

export const CORS_ORIGIN = 'https://contract.example.test';
const CONTAINER_PORT = process.env['CONTRACT_CONTAINER_PORT'] ?? '80';
const NAME_PREFIX = 'agent-service-contract';

function exec(cmd: string, args: string[], timeoutMs = 120_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 64 << 20 }, (err, stdout, stderr) => {
      const code = err === null ? 0 : typeof err.code === 'number' ? err.code : 1;
      resolve({ code, stdout, stderr });
    });
  });
}

function isProcessMode(): boolean {
  return process.env['CONTRACT_COMMAND'] !== undefined && process.env['CONTRACT_COMMAND'] !== '';
}

function requireImage(): string {
  const image = process.env['CONTRACT_IMAGE'];
  if (image === undefined || image === '') {
    throw new Error('CONTRACT_IMAGE must name the image under test (or set CONTRACT_COMMAND to run a local process)');
  }
  return image;
}

/** The environment a service instance is started with. */
export function defaultEnv(stubs: StubPorts): Record<string, string> {
  const stubHost = process.env['CONTRACT_STUB_HOST'] ?? (isProcessMode() ? '127.0.0.1' : 'host.docker.internal');
  const mysqlHost = process.env['CONTRACT_MYSQL_HOST'] ?? (isProcessMode() ? '127.0.0.1' : 'host.docker.internal');
  return {
    PORT: CONTAINER_PORT,
    ST_GATEWAY_URL: `http://${stubHost}:${stubs.gateway}`,
    AUTH_INTROSPECTION_URL: `http://${stubHost}:${stubs.center}/auth/v1/introspect`,
    AUTH_INTROSPECTION_SECRET: stubs.centerSecret,
    CORS_ALLOWED_ORIGIN: CORS_ORIGIN,
    MYSQL_HOST: mysqlHost,
    MYSQL_PORT: process.env['CONTRACT_MYSQL_PORT'] ?? '3306',
    MYSQL_USER: process.env['CONTRACT_MYSQL_USER'] ?? 'root',
    MYSQL_PASSWORD: process.env['CONTRACT_MYSQL_PASSWORD'] ?? 'example',
    MYSQL_DATABASE: process.env['CONTRACT_MYSQL_DATABASE'] ?? 'vnm-agent-db',
  };
}

function mergeEnv(base: Record<string, string>, opts: ServiceOptions): Record<string, string> {
  const merged: Record<string, string | undefined> = { ...base, ...(opts.env ?? {}) };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(merged)) if (v !== undefined) out[k] = v;
  return out;
}

const running = new Set<() => Promise<void>>();

/** Last-resort cleanup for a crashed or interrupted run. */
export async function stopEverything(): Promise<void> {
  await Promise.all([...running].map((stop) => stop().catch(() => undefined)));
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void stopEverything().finally(() => process.exit(130));
  });
}

async function waitForHealth(baseUrl: string, alive: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = 'no answer yet';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2_000) });
      if (res.status === 200) return;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    if (!(await alive())) throw new Error('the service exited before /health answered');
    await sleep(500);
  }
  throw new Error(`/health did not answer 200 within ${timeoutMs} ms (last: ${last})`);
}

export async function startService(stubs: StubPorts, opts: ServiceOptions = {}): Promise<RunningService> {
  const env = mergeEnv(defaultEnv(stubs), opts);
  return isProcessMode() ? startProcess(env) : startContainer(env);
}

async function startContainer(env: Record<string, string>): Promise<RunningService> {
  const image = requireImage();
  const name = `${NAME_PREFIX}-${process.pid}-${randomBytes(3).toString('hex')}`;
  const args = ['run', '-d', '--name', name, '--add-host=host.docker.internal:host-gateway', '-p', `127.0.0.1::${CONTAINER_PORT}`];
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
  args.push(image);

  const started = await exec('docker', args);
  if (started.code !== 0) throw new Error(`docker run failed: ${started.stderr || started.stdout}`);

  const stop = async (): Promise<void> => {
    running.delete(stop);
    await exec('docker', ['rm', '-f', '-v', name]);
  };
  running.add(stop);
  const logs = async (): Promise<string> => {
    const r = await exec('docker', ['logs', name]);
    return r.stdout + r.stderr;
  };

  try {
    const port = await exec('docker', ['port', name, `${CONTAINER_PORT}/tcp`]);
    const mapped = /127\.0\.0\.1:(\d+)/.exec(port.stdout);
    if (port.code !== 0 || mapped === null) {
      throw new Error(`could not find the published port: ${port.stdout}${port.stderr}`);
    }
    const baseUrl = `http://127.0.0.1:${mapped[1]}`;
    await waitForHealth(
      baseUrl,
      async () => (await exec('docker', ['inspect', '-f', '{{.State.Running}}', name])).stdout.trim() === 'true',
      120_000,
    );
    return { baseUrl, logs, stop };
  } catch (err) {
    const tail = (await logs()).split('\n').slice(-60).join('\n');
    await stop();
    throw new Error(`${err instanceof Error ? err.message : String(err)}\n--- service log ---\n${tail}`);
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

async function startProcess(env: Record<string, string>): Promise<RunningService> {
  const port = await freePort();
  const child: ChildProcess = spawn(process.env['CONTRACT_COMMAND'] as string, {
    shell: true,
    env: { ...process.env, ...env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (c: Buffer) => (output += c.toString()));
  child.stderr?.on('data', (c: Buffer) => (output += c.toString()));
  let exited = false;
  child.once('exit', () => (exited = true));

  const stop = async (): Promise<void> => {
    running.delete(stop);
    if (exited) return;
    if (process.platform === 'win32' && child.pid !== undefined) {
      await exec('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    } else {
      child.kill('SIGKILL');
    }
  };
  running.add(stop);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(baseUrl, async () => !exited, 120_000);
  } catch (err) {
    await stop();
    throw new Error(`${err instanceof Error ? err.message : String(err)}\n--- service log ---\n${output.slice(-4000)}`);
  }
  return { baseUrl, logs: async () => output, stop };
}

export interface Exited {
  code: number;
  output: string;
}

/**
 * Start the service in a configuration it is expected to refuse, and report how
 * it ended. Rejects if it is still running after timeoutMs.
 */
export async function runToExit(stubs: StubPorts, opts: ServiceOptions, timeoutMs = 15_000): Promise<Exited> {
  const env = mergeEnv(defaultEnv(stubs), opts);
  if (isProcessMode()) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.env['CONTRACT_COMMAND'] as string, {
        shell: true,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout?.on('data', (c: Buffer) => (output += c.toString()));
      child.stderr?.on('data', (c: Buffer) => (output += c.toString()));
      const timer = setTimeout(() => {
        if (process.platform === 'win32' && child.pid !== undefined) void exec('taskkill', ['/pid', String(child.pid), '/T', '/F']);
        else child.kill('SIGKILL');
        reject(new Error(`still running after ${timeoutMs} ms; output so far:\n${output}`));
      }, timeoutMs);
      child.once('exit', (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, output });
      });
    });
  }

  const image = requireImage();
  const name = `${NAME_PREFIX}-x-${process.pid}-${randomBytes(3).toString('hex')}`;
  const args = ['run', '--name', name, '--add-host=host.docker.internal:host-gateway'];
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
  args.push(image);
  const stop = async (): Promise<void> => {
    running.delete(stop);
    await exec('docker', ['rm', '-f', '-v', name]);
  };
  running.add(stop);
  try {
    const r = await exec('docker', args, timeoutMs);
    // execFile kills on timeout and reports a signal rather than a code; make
    // that visible instead of reading as an exit.
    const state = await exec('docker', ['inspect', '-f', '{{.State.Running}} {{.State.ExitCode}}', name]);
    const [stillRunning, exitCode] = state.stdout.trim().split(' ');
    if (stillRunning === 'true') throw new Error(`still running after ${timeoutMs} ms; output so far:\n${r.stdout}${r.stderr}`);
    return { code: Number(exitCode), output: r.stdout + r.stderr };
  } finally {
    await stop();
  }
}

/** Persist a log next to the suite so CI can print it when the run failed. */
export function saveLog(file: string, content: string): void {
  mkdirSync('.out', { recursive: true });
  writeFileSync(`.out/${file}`, content);
}
