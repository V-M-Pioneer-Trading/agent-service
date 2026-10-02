// A deliberately low-level HTTP client over node:http.
//
// fetch() cannot be used for most of the path and header cases this suite pins:
// it normalises dot segments and repeated slashes in the URL before sending, and
// it folds repeated headers into one. Here the request target and every header
// line go on the wire exactly as written.

import http from 'node:http';

export interface Res {
  status: number;
  /** Lower-cased names. Repeated headers are joined with ", " by node. */
  headers: Record<string, string | string[] | undefined>;
  rawHeaders: string[];
  body: Buffer;
  text: string;
}

export interface Req {
  method?: string;
  /** The request target, sent verbatim (path plus optional query). */
  path: string;
  /** A value that is an array is sent as one header line per element. */
  headers?: Record<string, string | string[]>;
  body?: string | Buffer;
  timeoutMs?: number;
}

const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });

export function destroyAgent(): void {
  agent.destroy();
}

export function send(baseUrl: string, req: Req): Promise<Res> {
  const url = new URL(baseUrl);
  return new Promise<Res>((resolve, reject) => {
    const headers: Record<string, string | string[]> = { ...(req.headers ?? {}) };
    const names = Object.keys(headers).map((h) => h.toLowerCase());
    if (req.body !== undefined && !names.includes('content-length') && !names.includes('transfer-encoding')) {
      headers['Content-Length'] = String(Buffer.byteLength(req.body));
    }
    const r = http.request(
      {
        host: url.hostname,
        port: url.port,
        method: req.method ?? 'GET',
        path: req.path,
        headers,
        agent,
        timeout: req.timeoutMs ?? 30_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('error', reject);
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            rawHeaders: res.rawHeaders,
            body,
            text: body.toString('utf8'),
          });
        });
      },
    );
    r.on('timeout', () => r.destroy(new Error(`${req.method ?? 'GET'} ${req.path}: timed out`)));
    r.on('error', reject);
    if (req.body !== undefined) r.write(req.body);
    r.end();
  });
}

export function header(res: Res, name: string): string | undefined {
  const v = res.headers[name.toLowerCase()];
  return Array.isArray(v) ? v.join(', ') : v;
}

export function json(res: Res): unknown {
  return JSON.parse(res.text);
}
