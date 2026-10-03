/**
 * @file Go's writeJSON: `Content-Type: application/json` with no charset and a
 * trailing newline. Express' res.json (which clerk-client's rejections and
 * tsoa's generated routes both call) adds `; charset=utf-8`, which the
 * contract compares. Installed per response; wrap in passthrough() at the call site.
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";

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
