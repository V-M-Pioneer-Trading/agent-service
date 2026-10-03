/**
 * @file Reading a request body the way the Go handlers do: `json.NewDecoder(http.MaxBytesReader(w,
 * r.Body, 1 MiB)).Decode(&v)` (contract README notes 28-29). No body parser is mounted anywhere:
 * `express.json()` and tsoa's own validation would answer before the handler, with sentences and
 * rules of their own.
 *
 *  - the cap is 1 MiB of bytes read from the stream; a value that is complete inside them is used
 *    whatever follows (the decoder never reads on), one that runs past them is the 400
 *    "http: request body too large";
 *  - Content-Type is never looked at, and neither is Content-Encoding or the length the caller
 *    announced: the bytes that arrive are the body, chunked or not;
 *  - a caller who hangs up before the body is in is `CallerGone`: nobody is left to answer.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { CallerGone } from "../gateway/client";
import { DecodeError, decodeFirstValue, type Decoded, type Schema } from "../gateway/decode";
import { TextAnswer } from "./json";

/** maxBodyBytes: every POST here carries a handful of short fields; a ceiling keeps an unauthenticated caller from making the service buffer an arbitrarily large body. */
export const MAX_BODY_BYTES = 1 << 20;
export const TOO_LARGE = "http: request body too large";

export interface BodyRead {
  /** At most `limit` bytes. */
  readonly bytes: Buffer;
  /** True when the caller sent more than `limit`; the rest is discarded. */
  readonly exceeded: boolean;
}

export function readBody(req: IncomingMessage, limit: number = MAX_BODY_BYTES): Promise<BodyRead> {
  // The body is wanted: a caller who asked to be told when to send it (Expect: 100-continue) is told now, not before auth.
  const res = (req as { res?: ServerResponse }).res;
  if (/100-continue/i.test(req.headers.expect ?? "") && res !== undefined && !res.headersSent) res.writeContinue();
  return new Promise<BodyRead>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (): boolean => {
      if (settled) return false;
      settled = true;
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("close", onClose);
      req.off("error", onError);
      return true;
    };
    function onData(chunk: Buffer): void {
      size += chunk.length;
      chunks.push(chunk);
      if (size <= limit || !settle()) return;
      // Over the cap: what came is enough to judge by. The rest is not read at all: the connection is closed once the
      // 400 is out (server.ts closeWhenBodyUnread), like Go's, and nothing is drained.
      req.pause();
      resolve({ bytes: Buffer.concat(chunks).subarray(0, limit), exceeded: true });
    }
    function onEnd(): void {
      if (settle()) resolve({ bytes: Buffer.concat(chunks), exceeded: false });
    }
    function onClose(): void {
      // 'close' after 'end' is normal; before it, the caller is gone.
      if (settle()) reject(new CallerGone());
    }
    function onError(): void {
      if (settle()) reject(new CallerGone());
    }
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("close", onClose);
    req.on("error", onError);
  });
}

/**
 * decodeBody: the first JSON value of the request body, bound to `schema` with Go's rules.
 * Anything the decoder refuses is the 400 `invalid request body: <explanation>`; the wording of the
 * explanation is not pinned, its presence is. A value cut short by the cap is "too large".
 */
export async function decodeBody<S extends Schema>(req: IncomingMessage, schema: S): Promise<Decoded<S>> {
  const { bytes, exceeded } = await readBody(req);
  try {
    return decodeFirstValue(schema, bytes);
  } catch (err) {
    if (!(err instanceof DecodeError)) throw err;
    const explanation = exceeded && err.message === "unexpected EOF" ? TOO_LARGE : err.message;
    throw new TextAnswer(400, `invalid request body: ${explanation}`);
  }
}
