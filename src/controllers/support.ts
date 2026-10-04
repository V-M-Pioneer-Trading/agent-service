/**
 * @file What the live-read controllers share: where the gateway client lives,
 * the caller, and how an answer is written.
 */

import type { Request, Response } from "express";
import type { HistoryStore } from "../db/history";
import type { Caller, GatewayClient } from "../gateway/client";
import { sendJson } from "../http/json";

export const GATEWAY_LOCAL = "gateway";
export const HISTORY_LOCAL = "history";
export const ERROR_LOG_LOCAL = "errorLog";

/** The client the app was built with (server.ts puts it in app.locals). */
export const gatewayOf = (req: Request): GatewayClient => req.app.locals[GATEWAY_LOCAL] as GatewayClient;

/** The history tables (the app was built with them). */
export const historyOf = (req: Request): HistoryStore => req.app.locals[HISTORY_LOCAL] as HistoryStore;

/** Where a failed best-effort write is logged (Go's log.Printf). */
export const errorLogOf = (req: Request): ((line: string) => void) => req.app.locals[ERROR_LOG_LOCAL] as (line: string) => void;

/**
 * The caller as the gateway client wants to know them: their Authorization header, verbatim (the one
 * thing forwarded to st-gateway, invariant 2; only a route behind a declaration that has accepted it
 * reaches a controller, so there is exactly one line), and a signal that fires when they hang up
 * before the answer is out, so that the calls still to make are not made (Go's request context).
 */
export function callerOf(req: Request): Caller {
  const res = req.res as Response;
  const gone = new AbortController();
  res.once("close", () => {
    if (!res.writableFinished) gone.abort();
  });
  return { authorization: req.headers.authorization ?? "", signal: gone.signal };
}

/**
 * Writes the answer and returns it. tsoa's own writer would turn a null list
 * into an empty 204 and cannot print an int64 above 2^53, so the controllers
 * write the answer themselves; tsoa then sees the response sent and leaves it
 * alone. The returned value is typed as the spec's model: same shape, with
 * bigint where the spec says integer, which is exactly what the writer prints.
 */
export async function answer<Model>(req: Request, value: unknown): Promise<Model> {
  await sendJson(req.res as Response, value);
  return value as unknown as Model;
}
