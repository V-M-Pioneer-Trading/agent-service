/**
 * @file Go's writeJSON: `Content-Type: application/json` with no charset and a
 * trailing newline. Express' res.json (which clerk-client's rejections and
 * tsoa's generated routes both call) adds `; charset=utf-8`, which the
 * contract compares. Installed per response; wrap in passthrough() at the call site.
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";
import { hasUnencodable, jsonPieces } from "../gateway/json";

export const goJson: RequestHandler = (_req: Request, res: Response, next: NextFunction) => {
  res.json = ((body: unknown) => {
    res.setHeader("Content-Type", "application/json");
    res.end(`${JSON.stringify(body)}\n`);
    return res;
  }) as Response["json"];
  next();
};

/** net/http's http.Error: text/plain, the message and one newline. */
export function sendText(res: Response, status: number, message: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(`${message}\n`);
}

/** About how much is written to the socket at a time. */
const CHUNK = 1 << 20;

/**
 * Go's writeJSON for a decoded value: `application/json`, the value as lossless JSON, a newline.
 * Written in pieces, so that an answer too big for one string (Go streams it) still goes out. Go
 * encodes before it writes, and a value it cannot encode (a time with a zone offset of a day or
 * more) leaves a 200 with no body.
 */
export async function sendJson(res: Response, value: unknown): Promise<void> {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  if (hasUnencodable(value)) {
    res.end();
    return;
  }
  let pending: string[] = [];
  let size = 0;
  for (const piece of jsonPieces(value)) {
    pending.push(piece);
    size += piece.length;
    if (size < CHUNK) continue;
    const full = res.write(pending.join(""));
    pending = [];
    size = 0;
    if (res.destroyed) return;
    if (!full) await new Promise<void>((resolve) => {
      res.once("drain", resolve);
      res.once("close", resolve);
    });
  }
  pending.push("\n");
  res.end(pending.join(""));
}
