/**
 * @file What the live-read controllers share: where the gateway client lives,
 * the caller's session header, and how an answer is written.
 */

import type { Request, Response } from "express";
import type { GatewayClient } from "../gateway/client";
import { sendJson } from "../http/json";

export const GATEWAY_LOCAL = "gateway";

/** The client the app was built with (server.ts puts it in app.locals). */
export const gatewayOf = (req: Request): GatewayClient => req.app.locals[GATEWAY_LOCAL] as GatewayClient;

/**
 * The caller's Authorization header, verbatim: the one thing forwarded to
 * st-gateway (invariant 2). Only a route behind a declaration that has
 * already accepted it reaches a controller, so there is exactly one line.
 */
export const callerSession = (req: Request): string => req.headers.authorization ?? "";

/**
 * Writes the answer and returns it. tsoa's own writer would turn a null list
 * into an empty 204 and cannot print an int64 above 2^53, so the controllers
 * write the answer themselves; tsoa then sees the response sent and leaves it
 * alone. The returned value is typed as the spec's model: same shape, with
 * bigint where the spec says integer, which is exactly what stringifyJson prints.
 */
export function answer<Model>(req: Request, value: unknown): Model {
  sendJson(req.res as Response, value);
  return value as unknown as Model;
}
