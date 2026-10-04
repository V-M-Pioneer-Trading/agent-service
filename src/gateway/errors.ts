/**
 * @file The upstream-error mapping for st-gateway's answers: what a caller
 * receives when the gateway does not answer with a 2xx.
 *
 * Ports the former Go service's src/spacetraders/{errors,client}.go and writeUpstreamError (deleted in agent-service#38; see 65bb4b2). The shared
 * contract is meta/fixtures/gateway-errors.json (see contract/fixtures); it is
 * driven through this module by __tests__/gatewayErrors.test.ts. The transport
 * is client.ts; the route handlers let these errors reach the app's error
 * handler (server.ts), which calls `writeUpstreamError`.
 *
 * The status and message are the gateway's own wherever it answered at all.
 * This service classifies exactly one condition itself, "the gateway did not
 * answer me" (504), and keeps 502 for a 2xx it cannot read. See meta's
 * docs/design/upstream-errors.md.
 */

import type { Response } from "express";
import { goTrimSpace } from "../config";
import { sendText } from "../http/json";
import { DecodeError, decode, struct, text } from "./decode";
import { validLength } from "./json";

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
  /** The sentence as bytes, when it is not valid UTF-8: Go relays a raw body as it came. */
  readonly raw: Buffer | undefined;

  constructor(statusCode: number, message: string, endpoint: string, headers: Record<string, string> = {}, options?: { cause?: unknown; raw?: Buffer }) {
    super(message, options);
    this.name = "UpstreamError";
    this.statusCode = statusCode;
    this.endpoint = endpoint;
    this.headers = headers;
    this.raw = options?.raw;
  }
}

/** A 2xx answer this service could not read: 502. */
export class UnreadableAnswer extends Error {
  constructor(detail: string) {
    super(`st-gateway answered with something unreadable: ${detail}`);
    this.name = "UnreadableAnswer";
  }
}

const envelope = struct({ error: struct({ message: text }) });

/**
 * error.message of an envelope, or null when the body is not one: decoded by the same rules as every
 * other gateway answer (names match case-insensitively under Go's folding, the last repeat wins, null
 * is absent, a wrongly typed member fails the whole decode, trailing data is an error). "" means a
 * valid document with no message.
 */
function envelopeMessage(body: Uint8Array): string | null {
  try {
    return decode(envelope, body).error.message;
  } catch (err) {
    if (err instanceof DecodeError) return null;
    throw err;
  }
}

/**
 * The human-readable reason in an error body (client.go upstreamMessage): the envelope's message; else
 * the body, cut to 500 runes (Go counts each byte that is not UTF-8 as one rune, and writes it as U+FFFD
 * once it cuts); `raw` is set when the body goes out untouched and is not valid UTF-8.
 */
export function upstreamMessageOf(body: Uint8Array | string): { message: string; raw?: Buffer } {
  const bytes = Buffer.from(typeof body === "string" ? Buffer.from(body, "utf8") : body);
  const lifted = envelopeMessage(bytes);
  if (lifted !== null && goTrimSpace(lifted) !== "") return { message: lifted };
  const runes: string[] = [];
  let valid = true;
  for (let i = 0; i < bytes.length; ) {
    const len = validLength(bytes, i);
    valid &&= len > 0;
    runes.push(len === 0 ? "\ufffd" : bytes.toString("utf8", i, i + len));
    i += Math.max(len, 1);
  }
  const text = runes.join("");
  if (goTrimSpace(text) === "") return { message: NO_MESSAGE };
  if (runes.length > MAX_MESSAGE_LENGTH) return { message: runes.slice(0, MAX_MESSAGE_LENGTH).join("") };
  return valid ? { message: text } : { message: text, raw: bytes };
}

export const upstreamMessage = (body: Uint8Array | string): string => upstreamMessageOf(body).message;

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
  const { message, raw } = upstreamMessageOf(body);
  return new UpstreamError(res.status, message, `${method} ${endpoint}`, pacingHeaders(res.headers), raw === undefined ? {} : { raw });
}

/** Relays the verdict: the gateway's status (502 outside 400-599), its sentence, its pacing headers; text/plain. */
export function writeUpstreamError(res: Response, err: unknown, log: (line: string) => void = console.error): void {
  log(`upstream call failed: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof UpstreamError) {
    const status = err.statusCode < 400 || err.statusCode > 599 ? 502 : err.statusCode;
    for (const [name, value] of Object.entries(err.headers)) res.setHeader(name, value);
    sendText(res, status, err.raw ?? err.message);
    return;
  }
  sendText(res, 502, err instanceof Error ? err.message : String(err));
}
