/**
 * @file The Go corsMiddleware: four constant headers, a 204 for OPTIONS.
 * Not the `cors` package: that adds Vary and different Allow-Methods.
 * Wrap in passthrough() at the call site: it answers preflights only.
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";

export function corsHeaders(allowedOrigin: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    // Pacing headers relayed from st-gateway; none is CORS-safelisted.
    res.setHeader("Access-Control-Expose-Headers", "Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset");
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }
    next();
  };
}
