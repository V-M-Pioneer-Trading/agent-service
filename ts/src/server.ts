import {
  createExpressAuth,
  notFound,
  passthrough,
  secured,
  type ExpressAuth,
} from "@v-m-pioneer-trading/clerk-client";
import express, { type ErrorRequestHandler, type Request, type Response } from "express";
import { declaring, routePolicy, type Policy, type Registrar } from "./auth";
import { ConfigError, loadConfig, type Config } from "./config";
import { RegisterRoutes } from "./generated/routes";
import { corsHeaders } from "./http/cors";
import { goJson, sendText } from "./http/json";
import { muxCompat, terminalAnswer } from "./http/muxCompat";

export interface AppDeps {
  readonly corsAllowedOrigin: string;
  readonly auth: ExpressAuth;
  /** Replaces the policy table (tests). */
  readonly policy?: Policy;
  /** Replaces tsoa's RegisterRoutes (tests); receives the declaring registrar and the secured app itself (for the routes tsoa cannot register, e.g. Swagger UI). */
  readonly registerRoutes?: (registrar: Registrar, app: express.Express) => void;
  /** One line per request, like the Go logging middleware; off unless given. */
  readonly log?: (line: string) => void;
}

/**
 * Builds the app. Order is load-bearing:
 *
 *  1. goJson: Go's JSON content type, also for clerk-client's rejections.
 *  2. muxCompat: 400 / 301 / decoded routing, before anything else can answer.
 *  3. CORS: constants on every response a matched route produces; a preflight
 *     is answered here, before the credential check, on every path.
 *  4. the routes, each behind its declaration (auth.ts). The app is secured():
 *     an undeclared route refuses startup, for any method.
 *  5. notFound(): 404 / 405 exactly as the Go router answers them.
 *  6. the error handler.
 *
 * No body parser is mounted: request bodies are read by the handlers that
 * need them, with the Go decoder's semantics (route PRs).
 */
export function createApp(deps: AppDeps) {
  const app = secured(express());
  app.disable("x-powered-by");
  app.set("etag", false);
  // mux is case sensitive and tolerates no trailing slash.
  app.set("case sensitive routing", true);
  app.set("strict routing", true);

  if (deps.log !== undefined) {
    const log = deps.log;
    app.use(passthrough((req: Request, _res: Response, next: () => void) => {
      log(`${req.method} request: to ${req.url}`);
      next();
    }, "logs the request line; never answers"));
  }
  app.use(passthrough(goJson, "installs Go's JSON writer on the response; never answers"));
  app.use(passthrough(muxCompat, "mirrors gorilla/mux path cleaning and net/http's URL refusals; serves no resource"));
  app.use(passthrough(corsHeaders(deps.corsAllowedOrigin), "answers CORS preflights; never serves a resource"));

  const register = deps.registerRoutes ?? ((r: Registrar) => RegisterRoutes(r as never));
  register(declaring(app as unknown as Registrar, deps.auth, deps.policy ?? routePolicy), app);

  app.use(notFound(terminalAnswer));

  const onError: ErrorRequestHandler = (err: unknown, _req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    console.error(err);
    sendText(res, 500, "Internal Server Error");
  };
  app.use(onError);
  return app;
}

/** Startup. Every refusal exits 1 before a port is bound, like log.Fatal in Go. */
export function main(env: NodeJS.ProcessEnv = process.env): void {
  let config: Config;
  let app: ReturnType<typeof createApp>;
  try {
    config = loadConfig(env);
    app = createApp({
      corsAllowedOrigin: config.corsAllowedOrigin,
      auth: createExpressAuth(config.introspection),
      log: (line) => console.log(line),
    });
  } catch (err) {
    console.error(err instanceof ConfigError ? err.message : err);
    process.exit(1);
  }

  const server = app.listen(config.port, () => console.log(`agent-service listening on :${config.port}`));
  // Reading is bounded like the Go server's; writing deliberately is not.
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 120_000;
  server.on("error", (err) => {
    console.error(err);
    process.exit(1);
  });

  const shutdown = (signal: string) => {
    console.log(`received ${signal}, shutting down`);
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => shutdown(signal));
}

if (require.main === module) main();
