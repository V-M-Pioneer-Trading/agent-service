/**
 * @file The upstream-error mapping for st-gateway's answers: what a caller
 * receives when the gateway does not answer with a 2xx.
 *
 * Ports src/spacetraders/{errors,client}.go and writeUpstreamError. The shared
 * contract is meta/fixtures/gateway-errors.json (see contract/fixtures); it is
 * driven through this module by __tests__/gatewayErrors.test.ts. The route PRs
 * (live reads, writes) call `callGateway` and `writeUpstreamError`.
 *
 * The status and message are the gateway's own wherever it answered at all.
 * This service classifies exactly one condition itself, "the gateway did not
 * answer me" (504), and keeps 502 for a 2xx it cannot read. See meta's
 * docs/design/upstream-errors.md.
 */

import type { Response } from "express";
import { sendText } from "../http/json";

/** Pacing signals st-gateway forwards on a passed-through error, relayed to the caller. */
export const FORWARDED_HEADERS = ["Retry-After", "X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset"] as const;
/** How much of a failing answer is read at all. */
export const MAX_ERROR_BODY = 64 << 10;
/** The longest raw (non-envelope) body worth relaying, in characters. */
export const MAX_MESSAGE_LENGTH = 500;
/** Every upstream call is bounded. */
export const REQUEST_TIMEOUT_MS = 30_000;
export const NO_ANSWER = "st-gateway did not answer";
export const NO_MESSAGE = "st-gateway returned an error with no message";

export class UpstreamError extends Error {
  readonly statusCode: number;
  /** For the log line, not the caller: one request can make several calls. */
  readonly endpoint: string;
  readonly headers: Readonly<Record<string, string>>;

  constructor(statusCode: number, message: string, endpoint: string, headers: Record<string, string> = {}, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "UpstreamError";
    this.statusCode = statusCode;
    this.endpoint = endpoint;
    this.headers = headers;
  }
}

/** A 2xx answer this service could not read: 502. */
export class UnreadableAnswer extends Error {
  constructor(detail: string) {
    super(`st-gateway answered with something unreadable: ${detail}`);
    this.name = "UnreadableAnswer";
  }
}

/**
 * error.message of an envelope, or null when the body is not one: the Go
 * decoder's rules (names match case-insensitively, the last repeat wins, null
 * is absent, a wrongly typed member fails the whole decode, trailing data is
 * an error). "" means a valid document with no message.
 */
function envelopeMessage(text: string): string | null {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (doc === null) return "";
  if (typeof doc !== "object" || Array.isArray(doc)) return null;
  let message = "";
  for (const [key, value] of Object.entries(doc)) {
    if (key.toLowerCase() !== "error" || value === null) continue;
    if (typeof value !== "object" || Array.isArray(value)) return null;
    for (const [inner, text2] of Object.entries(value)) {
      if (inner.toLowerCase() !== "message" || text2 === null) continue;
      if (typeof text2 !== "string") return null;
      message = text2;
    }
  }
  return message;
}

/** The human-readable reason in an error body (client.go upstreamMessage). */
export function upstreamMessage(body: Uint8Array | string): string {
  const text = typeof body === "string" ? body : Buffer.from(body).toString("utf8");
  const lifted = envelopeMessage(text);
  if (lifted !== null && lifted.trim() !== "") return lifted;
  if (text.trim() === "") return NO_MESSAGE;
  const chars = Array.from(text);
  return chars.length > MAX_MESSAGE_LENGTH ? chars.slice(0, MAX_MESSAGE_LENGTH).join("") : text;
}

/** The non-empty pacing headers, nothing else of the gateway's answer. */
export function pacingHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of FORWARDED_HEADERS) {
    const value = headers.get(name);
    if (value !== null && value !== "") out[name] = value;
  }
  return out;
}

/** The one verdict this service reaches on its own. The cause (it names the gateway's address) is kept for logs only. */
export function gatewayDidNotAnswer(method: string, endpoint: string, cause: unknown): UpstreamError {
  return new UpstreamError(504, NO_ANSWER, `${method} ${endpoint}`, {}, { cause });
}

/** At most `limit` bytes of a body; what arrived before a failure is kept. */
async function readCapped(res: globalThis.Response, limit: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (res.body === null) return new Uint8Array();
  const reader = res.body.getReader();
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
  } catch {
    // A half-delivered error body is used as far as it came.
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).subarray(0, limit);
}

/** The UpstreamError for a gateway answer with status >= 400. */
export async function upstreamErrorFrom(res: globalThis.Response, method: string, endpoint: string): Promise<UpstreamError> {
  const body = await readCapped(res, MAX_ERROR_BODY);
  return new UpstreamError(res.status, upstreamMessage(body), `${method} ${endpoint}`, pacingHeaders(res.headers));
}

/**
 * One call through st-gateway: parsed JSON of a 2xx (undefined for an empty
 * body), or a thrown UpstreamError (504 for no answer, the gateway's own
 * status for >= 400) or UnreadableAnswer (502). The caller's Authorization is
 * passed in, never read from anywhere else.
 *
 * Typed decoding and redirect following belong to the route PRs.
 */
export async function callGateway(
  method: string,
  url: string,
  endpoint: string,
  init: { authorization?: string; body?: string; fetchImpl?: typeof fetch } = {},
): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (init.authorization !== undefined && init.authorization !== "") headers["Authorization"] = init.authorization;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";

  let res: globalThis.Response;
  try {
    res = await (init.fetchImpl ?? fetch)(url, {
      method,
      headers,
      ...(init.body !== undefined ? { body: init.body } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw gatewayDidNotAnswer(method, endpoint, err);
  }
  if (res.status >= 400) throw await upstreamErrorFrom(res, method, endpoint);

  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    // The body died mid-read: the answer never arrived.
    throw gatewayDidNotAnswer(method, endpoint, err);
  }
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new UnreadableAnswer(err instanceof Error ? err.message : "invalid JSON");
  }
}

/** Relays the verdict: the gateway's status (502 outside 400-599), its sentence, its pacing headers; text/plain. */
export function writeUpstreamError(res: Response, err: unknown, log: (line: string) => void = console.error): void {
  log(`upstream call failed: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof UpstreamError) {
    const status = err.statusCode < 400 || err.statusCode > 599 ? 502 : err.statusCode;
    for (const [name, value] of Object.entries(err.headers)) res.setHeader(name, value);
    sendText(res, status, err.message);
    return;
  }
  sendText(res, 502, err instanceof Error ? err.message : String(err));
}
