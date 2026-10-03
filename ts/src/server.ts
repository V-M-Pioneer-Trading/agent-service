import {
  createExpressAuth,
  notFound,
  passthrough,
  secured,
  type ExpressAuth,
} from "@v-m-pioneer-trading/clerk-client";
import http from "node:http";
import express,{ type ErrorRequestHandler, type Request, type Response } from "express";
import { ERROR_LOG_LOCAL, GATEWAY_LOCAL, HISTORY_LOCAL } from "./controllers/support";
import { HistoryStore } from "./db/history";
import { setUpDatabase } from "./db/setup";
import { CallerGone, GatewayClient } from "./gateway/client";
import { UnreadableAnswer, UpstreamError, writeUpstreamError } from "./gateway/errors";
import { declaring, routePolicy, type Policy, type Registrar } from "./auth";
import { ConfigError, loadConfig, type Config } from "./config";
import { RegisterRoutes } from "./generated/routes";
import { corsHeaders } from "./http/cors";
import { goJson, sendText, TextAnswer } from "./http/json";
import { muxCompat, terminalAnswer } from "./http/muxCompat";
import { mountSwagger } from "./swagger";

/** How much of an unread request body is read, after the answer, to keep the connection (Go's maxPostHandlerReadBytes). */
export const UNREAD_BODY_ALLOWANCE = 256 << 10;

/** How long a connection is read from, after its answer, before it is closed (Go: 500 ms). */
export const CLOSE_WAIT_MS = 500;

export const closeWhenBodyUnread: express.RequestHandler = (req, res, next) => {
  res.once("finish", () => {
    if (req.readableEnded) return;
    // Go reads at most 256 KiB of a body the handler left alone (maxPostHandlerReadBytes) to keep the connection, and
    // closes it otherwise; Node would read and discard any amount. Past the allowance: Go's closeWriteAndWait, a FIN so
    // that the answer is read, then discarding for a short while (closing on unread data resets the connection and
    // the caller loses the answer), then close.
    const socket = req.socket;
    let seen = 0;
    // Counted on the socket: Node's own discard of an unread body never hands the bytes to the request.
    const count = (chunk: Buffer): void => {
      seen += chunk.length;
      if (seen <= UNREAD_BODY_ALLOWANCE) return;
      socket.off("data", count);
      socket.end();
      socket.resume();
      setTimeout(() => socket.destroy(), CLOSE_WAIT_MS).unref();
    };
    socket.on("data", count);
    // A handler that stopped reading (a body over the cap) left the request paused, and with it the socket.
    req.resume();
    req.once("end", () => socket.off("data", count));
  });
  next();
};

/** The server the process runs: reads are bounded like Go's, and a check every second makes the header timeout 10 s, not 10 to 40. */
export function createHttpServer(app: express.Express): http.Server {
  return http.createServer({ connectionsCheckingInterval: 1000, headersTimeout: 10_000, requestTimeout: 30_000, keepAliveTimeout: 120_000 }, app);
}

export interface AppDeps {
  readonly corsAllowedOrigin: string;
  readonly auth: ExpressAuth;
  /** The only way out of the service: st-gateway. */
  readonly gateway: GatewayClient;
  /** The history tables: what the writes record and the public reads serve. */
  readonly history: HistoryStore;
  /** Where a failed best-effort write is logged; the console's error stream if not given. */
  readonly errorLog?: (line: string) => void;
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
 * No body parser is mounted and Express' query parser is off: request bodies and
 * query strings are read by the handlers that need them, with the Go decoder's
 * and net/url's semantics (http/body.ts, http/query.ts).
 */
export function createApp(deps: AppDeps) {
  const app = secured(express());
  app.locals[GATEWAY_LOCAL] = deps.gateway;
  app.locals[HISTORY_LOCAL] = deps.history;
  app.locals[ERROR_LOG_LOCAL] = deps.errorLog ?? ((line: string) => console.error(line));
  app.disable("x-powered-by");
  app.set("etag", false);
  // mux is case sensitive and tolerates no trailing slash.
  app.set("case sensitive routing", true);
  app.set("strict routing", true);
  // The query string is read by the handlers with Go's rules (http/query.ts); Express' own parser (qs) reads it
  // differently, and tsoa would validate what it produced before the handler could.
  app.set("query parser", false);

  if (deps.log !== undefined) {
    const log = deps.log;
    app.use(passthrough((req: Request, _res: Response, next: () => void) => {
      log(`${req.method} request: to ${req.url}`);
      next();
    }, "logs the request line; never answers"));
  }
  // A response that is out while the request body is not all in closes the connection, as Go's server does after a
  // handler that did not read it (a 401 on a write route, a body over the cap): Node would read and discard the rest,
  // which an endless body turns into minutes of traffic.
  app.use(passthrough(closeWhenBodyUnread, "closes the connection after an answer that left the request body unread; never answers"));
  app.use(passthrough(goJson, "installs Go's JSON writer on the response; never answers"));
  app.use(passthrough(muxCompat, "mirrors gorilla/mux path cleaning and net/http's URL refusals; serves no resource"));
  app.use(passthrough(corsHeaders(deps.corsAllowedOrigin), "answers CORS preflights; never serves a resource"));

  const register =
    deps.registerRoutes ??
    ((r: Registrar, a: express.Express) => {
      RegisterRoutes(r as never);
      mountSwagger(a, deps.auth);
    });
  register(declaring(app as unknown as Registrar, deps.auth, deps.policy ?? routePolicy), app);

  app.use(notFound(terminalAnswer));

  const onError: ErrorRequestHandler = (err: unknown, _req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    // The caller left; nobody is there to answer, and the gateway did nothing wrong.
    if (err instanceof CallerGone) return;
    if (err instanceof TextAnswer) {
      sendText(res, err.status, err.message);
      return;
    }
    if (err instanceof UpstreamError || err instanceof UnreadableAnswer) {
      writeUpstreamError(res, err);
      return;
    }
    console.error(err);
    sendText(res, 500, "Internal Server Error");
  };
  app.use(onError);
  return app;
}

/** Startup. Every refusal exits 1 before a port is bound, like log.Fatal in Go. */
export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  let config: Config;
  try {
    // Introspection first, before the database wait: it is instant, and a missing AUTH_INTROSPECTION_*
    // must crash the container within the bootstrap script's liveness window rather than after a slow MySQL ping loop.
    config = loadConfig(env);
  } catch (err) {
    console.error(err instanceof ConfigError ? err.message : err);
    process.exit(1);
  }

  // Open the pool, wait for MySQL (15 pings, 2 s apart), migrate. All of it before any port is bound.
  let sql: Awaited<ReturnType<typeof setUpDatabase>>;
  try {
    sql = await setUpDatabase(config.mysql);
  } catch (err) {
    // One line, like log.Fatal: the pool's error says what it could not reach or run.
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }

  let app: ReturnType<typeof createApp>;
  try {
    app = createApp({
      corsAllowedOrigin: config.corsAllowedOrigin,
      auth: createExpressAuth(config.introspection),
      gateway: new GatewayClient(config.gatewayProxyUrl),
      history: new HistoryStore(sql),
      log: (line) => console.log(line),
    });
  } catch (err) {
    console.error(err);
    process.exit(1);
  }

  // Reading is bounded like the Go server's; writing deliberately is not. connectionsCheckingInterval (default 30 s)
  // is how often Node looks for requests past headersTimeout, so it is what makes 10 s mean 10 s.
  const server = createHttpServer(app);
  server.listen(config.port, () => console.log(`agent-service listening on :${config.port}`));
  server.on("error", (err) => {
    console.error(err);
    process.exit(1);
  });

  const shutdown = (signal: string) => {
    console.log(`received ${signal}, shutting down`);
    server.close(() => {
      void sql.close().finally(() => process.exit(0));
    });
    server.closeIdleConnections();
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => shutdown(signal));
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
