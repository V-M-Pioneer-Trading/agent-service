// Response assertions that encode the parity rules:
//
//   * status codes are compared exactly;
//   * of the headers, only the "relevant" ones are compared, and the set of
//     relevant headers present must match exactly (an extra Cache-Control or a
//     missing Access-Control-* header both fail);
//   * JSON bodies are parsed and deep-compared (key order and whitespace are
//     free; null versus missing and number versus string are not);
//   * plain-text bodies are compared byte for byte.

import assert from 'node:assert/strict';
import type { Res } from './http.ts';

export const JSON_TYPE = 'application/json';
export const TEXT_TYPE = 'text/plain; charset=utf-8';

/** The CORS headers corsMiddleware stamps on every response it runs for. */
export const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': 'https://contract.example.test',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'Content-Type, Authorization',
  'access-control-expose-headers': 'Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset',
};

/** The five sentences of the auth envelope. */
export const MSG = {
  missingToken: 'a bearer token is required',
  invalidSession: 'invalid or expired session',
  missingScope: 'this action requires a scope this session does not carry',
  undeclaredRoute: 'this route declares no required scope',
  centerUnavailable: 'the authentication service could not process this request',
} as const;

const RELEVANT = ['content-type', 'cache-control', 'allow', 'location', 'retry-after', 'vary', 'www-authenticate', 'set-cookie'];

function isRelevant(name: string): boolean {
  return RELEVANT.includes(name) || name.startsWith('access-control-') || name.startsWith('x-ratelimit-');
}

/** The relevant headers of a response, lower-cased, as one object. */
export function relevantHeaders(res: Res): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(res.headers)) {
    if (value === undefined || !isRelevant(name)) continue;
    out[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

/**
 * JSON.parse that does not lose integers beyond 2^53: a number whose source text
 * is an integer literal that a double cannot hold exactly comes back as a BigInt
 * (Node 24 passes the source text to the reviver). Expected values may therefore
 * contain BigInts, e.g. 9007199254740993n.
 */
export function parseExact(text: string): unknown {
  return JSON.parse(text, function (_key: string, value: unknown, context?: { source?: string }) {
    if (typeof value === 'number' && context?.source !== undefined && /^-?d+$/.test(context.source) && !Number.isSafeInteger(value)) {
      return BigInt(context.source);
    }
    return value;
  });
}

export interface Expectation {
  /** CORS headers expected (default true). false: none at all. */
  cors?: boolean;
  /** Other relevant headers expected, lower-cased names. */
  headers?: Record<string, string>;
}

function expectHeaders(res: Res, contentType: string | null, opts: Expectation): void {
  const want: Record<string, string> = {
    ...(opts.cors === false ? {} : CORS_HEADERS),
    ...(contentType === null ? {} : { 'content-type': contentType }),
    ...(opts.headers ?? {}),
  };
  assert.deepEqual(relevantHeaders(res), want, `relevant headers of the ${res.status} response`);
}

/** A JSON response: status, Content-Type application/json, deep-equal body. */
export function expectJson(res: Res, status: number, body: unknown, opts: Expectation = {}): void {
  assert.equal(res.status, status, `status (body: ${res.text.slice(0, 300)})`);
  expectHeaders(res, JSON_TYPE, opts);
  assert.deepEqual(parseExact(res.text), body);
}

/** The text/plain answer of Go's http.Error: the message plus one newline. */
export function expectText(res: Res, status: number, message: string, opts: Expectation = {}): void {
  assert.equal(res.status, status, `status (body: ${res.text.slice(0, 300)})`);
  expectHeaders(res, TEXT_TYPE, opts);
  assert.equal(res.text, `${message}\n`);
}

/** Same as expectText but only the start of the message is pinned. */
export function expectTextStartingWith(res: Res, status: number, prefix: string, opts: Expectation = {}): void {
  assert.equal(res.status, status, `status (body: ${res.text.slice(0, 300)})`);
  expectHeaders(res, TEXT_TYPE, opts);
  assert.ok(res.text.startsWith(prefix), `body ${JSON.stringify(res.text)} should start with ${JSON.stringify(prefix)}`);
  assert.ok(res.text.endsWith('\n'), 'body should end with a newline');
}

/** The {"error":{"message":...}} envelope every auth rejection uses. */
export function expectAuthError(res: Res, status: number, message: string, opts: Expectation = {}): void {
  expectJson(res, status, { error: { message } }, opts);
}

/** No body and no Content-Type: a 204, a bare 405, a HEAD response. */
export function expectNoBody(res: Res, status: number, opts: Expectation = {}): void {
  assert.equal(res.status, status);
  expectHeaders(res, null, opts);
  assert.equal(res.text, '');
}

/** What a HEAD answer must look like: the status and headers of its GET, no body. */
export function expectHeadOf(head: Res, get: Res): void {
  assert.equal(head.status, get.status, 'HEAD status');
  assert.deepEqual(relevantHeaders(head), relevantHeaders(get), 'HEAD relevant headers');
  assert.equal(head.text, '', 'HEAD body');
}

/**
 * Go's http.NotFound, which gorilla/mux's router answers for anything under
 * /api/agent that no route takes, and for a wrong method on a route there.
 * The middleware never runs for it: no CORS headers.
 */
export function expectNotFound(res: Res): void {
  expectText(res, 404, '404 page not found', { cors: false });
}
