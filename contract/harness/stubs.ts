// Programmable stand-ins for the two services agent-service talks to. They live
// in the test process, bound to 0.0.0.0 on random ports so a container can
// reach them through host.docker.internal.

import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

export interface Recorded {
  method: string;
  /** The request target exactly as received, e.g. "/proxy/my/ships/A%20B". */
  url: string;
  headers: http.IncomingHttpHeaders;
  rawHeaders: string[];
  body: string;
  rawBody: Buffer;
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function record(req: http.IncomingMessage): Promise<Recorded> {
  const rawBody = await readBody(req);
  return {
    method: req.method ?? '',
    url: req.url ?? '',
    headers: req.headers,
    rawHeaders: req.rawHeaders,
    body: rawBody.toString('utf8'),
    rawBody,
  };
}

abstract class Stub {
  readonly server: http.Server;
  port = 0;
  private readonly sockets = new Set<Socket>();

  protected abstract handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;

  constructor() {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    this.server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
  }

  async start(port = 0): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '0.0.0.0', () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    this.port = (this.server.address() as AddressInfo).port;
  }

  /**
   * Make the next connection attempt fail with ECONNREFUSED: stop listening and
   * drop what is open. restore() listens on the same port again.
   */
  async refuse(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  async restore(): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await new Promise<void>((resolve, reject) => {
          this.server.once('error', reject);
          this.server.listen(this.port, '0.0.0.0', () => {
            this.server.off('error', reject);
            resolve();
          });
        });
        return;
      } catch (err) {
        if (attempt >= 20) throw err;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

// ---------------------------------------------------------------- st-gateway

export interface GatewayReply {
  status?: number;
  /** Serialised as JSON. */
  json?: unknown;
  /** Sent as is; wins over json. */
  raw?: string | Buffer;
  headers?: Record<string, string>;
  delayMs?: number;
  /**
   * drop: close the socket without answering. truncate: promise a long body and
   * die after a few bytes. hang: never answer.
   */
  behaviour?: 'drop' | 'truncate' | 'hang';
}

export type GatewayScript = GatewayReply | ((req: Recorded) => GatewayReply);

export class GatewayStub extends Stub {
  /** Every request received since the last reset, in arrival order. */
  requests: Recorded[] = [];
  /** Requests nobody scripted. A test that causes one has a bug. */
  unscripted: Recorded[] = [];
  private scripts = new Map<string, GatewayScript[]>();

  reset(): void {
    this.requests = [];
    this.unscripted = [];
    this.scripts = new Map();
  }

  /**
   * Start a test over mid-test: forget what was scripted and recorded, but keep
   * `unscripted`, which the root afterEach checks. reset() would hide a stray call.
   */
  clearScripts(): void {
    this.requests = [];
    this.scripts = new Map();
  }

  /**
   * Script the answer to "METHOD /target". Several scripts for one key are
   * served in order, the last one repeating.
   */
  on(method: string, target: string, ...scripts: GatewayScript[]): void {
    this.scripts.set(`${method} ${target}`, scripts);
  }

  /** Requests for one target, e.g. calls('GET', '/proxy/my/agent'). */
  calls(method: string, target: string): Recorded[] {
    return this.requests.filter((r) => r.method === method && r.url === target);
  }

  protected override async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const rec = await record(req);
    this.requests.push(rec);
    const key = `${rec.method} ${rec.url}`;
    const list = this.scripts.get(key);
    if (list === undefined) {
      this.unscripted.push(rec);
      res.writeHead(599, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `contract stub: nothing scripted for ${key}` } }));
      return;
    }
    const script = list.length > 1 ? (list.shift() as GatewayScript) : (list[0] as GatewayScript);
    const reply = typeof script === 'function' ? script(rec) : script;
    if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
    switch (reply.behaviour) {
      case 'drop':
        req.socket.destroy();
        return;
      case 'hang':
        return;
      case 'truncate':
        res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json', 'Content-Length': '4096' });
        res.write('{"data":');
        setTimeout(() => req.socket.destroy(), 20);
        return;
      default:
        break;
    }
    const body = reply.raw !== undefined ? reply.raw : reply.json !== undefined ? JSON.stringify(reply.json) : '';
    res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json', ...(reply.headers ?? {}) });
    res.end(body);
  }
}

// ------------------------------------------------------- introspection center

export type CenterBehaviour =
  | {
      kind: 'active';
      sub?: string;
      /** undefined omits the key, which is what auth-service does for no scopes. */
      scope?: string | null;
      /** The center's classification. Anything but operator/machine is malformed. */
      subjectKind?: string;
      exp?: number;
      /** Extra top-level members, spliced in verbatim. */
      extra?: Record<string, unknown>;
    }
  | { kind: 'inactive' }
  | { kind: 'status'; status: number; body?: string }
  | { kind: 'raw'; body: string | Buffer; status?: number; headers?: Record<string, string> }
  | { kind: 'hang' }
  | { kind: 'delay'; ms: number; then: CenterBehaviour }
  | { kind: 'redirect'; location: string };

export interface CenterCall extends Recorded {
  /** The token field of the form body, or undefined when there was none. */
  token: string | undefined;
  secretOk: boolean;
}

export class CenterStub extends Stub {
  readonly secret = 'contract-introspection-secret-0123456789';
  calls: CenterCall[] = [];
  /** Requests that reached any path but the introspection endpoint. */
  strays: Recorded[] = [];
  private behaviours = new Map<string, CenterBehaviour>();
  private counter = 0;
  private readonly runId = Math.random().toString(36).slice(2, 8);

  reset(): void {
    this.calls = [];
    this.strays = [];
    this.behaviours = new Map();
  }

  /** Mint a token the center will answer for as scripted. Tokens are unique per call. */
  token(behaviour: CenterBehaviour, label = 'tok'): string {
    const token = `${label}-${this.runId}-${++this.counter}`;
    this.behaviours.set(token, behaviour);
    return token;
  }

  /** A token the center has never heard of: answered as inactive. */
  unknownToken(): string {
    return `unknown-${this.runId}-${++this.counter}`;
  }

  callsFor(token: string): CenterCall[] {
    return this.calls.filter((c) => c.token === token);
  }

  protected override async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const rec = await record(req);
    if (rec.url !== '/auth/v1/introspect') {
      this.strays.push(rec);
      res.writeHead(404);
      res.end();
      return;
    }
    const form = new URLSearchParams(rec.body);
    const token = form.get('token') ?? undefined;
    const secretOk = rec.headers['x-introspection-secret'] === this.secret;
    this.calls.push({ ...rec, token, secretOk });

    if (!secretOk || rec.method !== 'POST') {
      // The real center's answer about the caller's own secret.
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{"error":{"message":"invalid introspection secret"}}');
      return;
    }
    const behaviour: CenterBehaviour =
      token !== undefined && this.behaviours.has(token)
        ? (this.behaviours.get(token) as CenterBehaviour)
        : { kind: 'inactive' };
    await this.answer(req, res, behaviour);
  }

  private async answer(req: http.IncomingMessage, res: http.ServerResponse, b: CenterBehaviour): Promise<void> {
    switch (b.kind) {
      case 'hang':
        return;
      case 'delay':
        await new Promise((r) => setTimeout(r, b.ms));
        if (res.destroyed || req.socket.destroyed) return;
        return this.answer(req, res, b.then);
      case 'inactive':
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"active":false}');
        return;
      case 'status':
        res.writeHead(b.status, { 'Content-Type': 'application/json' });
        res.end(b.body ?? '{"error":{"message":"center failure"}}');
        return;
      case 'raw':
        res.writeHead(b.status ?? 200, { 'Content-Type': 'application/json', ...(b.headers ?? {}) });
        res.end(b.body);
        return;
      case 'redirect':
        res.writeHead(307, { Location: b.location });
        res.end();
        return;
      case 'active': {
        const answer: Record<string, unknown> = {
          active: true,
          sub: b.sub ?? 'user_contract',
          exp: b.exp ?? 4102444800,
          kind: b.subjectKind ?? 'operator',
          ...(b.extra ?? {}),
        };
        if (b.scope !== undefined) answer['scope'] = b.scope;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(answer));
        return;
      }
    }
  }
}
