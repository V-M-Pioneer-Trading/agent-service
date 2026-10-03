import net from "node:net";
import request from "supertest";
import { createExpressAuth } from "@v-m-pioneer-trading/clerk-client";
import express from "express";
import { declaring, routePolicy } from "../auth";
import { createApp } from "../server";
import { createTestApp, noGateway, stubCentre, TEST_ORIGIN } from "../testSupport/createTestApp";

const CORS = {
  "access-control-allow-origin": TEST_ORIGIN,
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "Content-Type, Authorization",
  "access-control-expose-headers": "Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset",
};
const corsOf = (headers: Record<string, unknown>) => Object.keys(headers).filter((h) => h.startsWith("access-control-"));

describe("health", () => {
  it.each(["/health", "/api/agent/health"])("GET %s answers {status:ok} as Go's JSON, with the CORS headers", async (path) => {
    const { app } = createTestApp();
    const res = await request(app).get(path);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
    expect(res.headers["content-type"]).toBe("application/json");
    expect(res.text.endsWith("\n")).toBe(true);
    expect(res.headers).toMatchObject(CORS);
    for (const absent of ["cache-control", "etag", "x-powered-by", "vary", "allow"]) expect(res.headers[absent]).toBeUndefined();
  });

  it("never reads credentials or asks the centre", async () => {
    const { app, centre } = createTestApp();
    for (const auth of ["Bearer abc", "Bearer", "Basic Zm9v", "garbage"]) {
      expect((await request(app).get("/health").set("Authorization", auth)).status).toBe(200);
    }
    expect((await request(app).get("/api/agent/health").set("Authorization", ["Bearer a", "Bearer b"] as never)).status).toBe(200);
    expect(centre.asked).toEqual([]);
  });

  it("HEAD is GET without the body", async () => {
    const { app } = createTestApp();
    const res = await request(app).head("/health");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");
    expect(res.text ?? "").toBe("");
  });
});

describe("the router answers like gorilla/mux", () => {
  const { app } = createTestApp();

  it.each(["/", "/nope", "/api", "/api/Agent/health", "/health/", "/health/extra"])("a bare 405 outside /api/agent: %s", async (path) => {
    for (const method of ["get", "post", "delete"] as const) {
      const res = await request(app)[method](path);
      expect(res.status).toBe(405);
      expect(res.text).toBe("");
      expect(res.headers["content-type"]).toBeUndefined();
      expect(res.headers["allow"]).toBeUndefined();
      expect(corsOf(res.headers)).toEqual([]);
    }
  });

  it.each(["/api/agent", "/api/agent/", "/api/agentx", "/api/agent/swagger", "/api/agent/v1/nope", "/api/agent/health/"])(
    "404 page not found under /api/agent: %s",
    async (path) => {
      const res = await request(app).get(path);
      expect(res.status).toBe(404);
      expect(res.text).toBe("404 page not found\n");
      expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
      expect(corsOf(res.headers)).toEqual([]);
    },
  );

  it("a wrong method on a route under /api/agent is that same 404, never a 405", async () => {
    const res = await request(app).post("/api/agent/health");
    expect(res.status).toBe(404);
    expect(res.text).toBe("404 page not found\n");
    expect((await request(app).delete("/health")).status).toBe(405);
  });

  it.each([
    ["/api/agent//health", "/api/agent/health"],
    ["//health", "/health"],
    ["/api/agent/./health", "/api/agent/health"],
    ["/api/agent/v1/ships/%2E%2E/agent", "/api/agent/v1/agent"],
    ["/api/agent//health?x=1&y=%20z", "/api/agent/health?x=1&y=%20z"],
    ["/health/.", "/health"],
    ["/api/agent/v1/transactions//?limit=5", "/api/agent/v1/transactions/?limit=5"],
  ])("%s is a 301 to %s, for every method, with no CORS headers", async (path, location) => {
    for (const method of ["get", "post", "options"] as const) {
      const res = await request(app)[method](path);
      expect(res.status).toBe(301);
      expect(res.headers["location"]).toBe(location);
      expect(res.text).toBe("");
      expect(corsOf(res.headers)).toEqual([]);
    }
  });

  it("routes on the decoded path, once", async () => {
    expect((await request(app).get("/%68%65%61%6C%74%68")).status).toBe(200);
    expect((await request(app).get("/api/agent/%68ealth")).status).toBe(200);
    expect((await request(app).get("/api/agent/%252568ealth")).status).toBe(404);
    expect((await request(app).get("/api/agent%2Fhealth")).status).toBe(200); // %2F is a slash
  });

  it.each(["/%zz", "/api/agent/ships/%", "/%4", "/api/agent/health%2"])("a malformed escape is a bare 400 and closes the connection: %s", async (path) => {
    const res = await request(app).get(path);
    expect(res.status).toBe(400);
    expect(res.text).toBe("400 Bad Request");
    expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(res.headers["connection"]).toBe("close");
    expect(corsOf(res.headers)).toEqual([]);
  });

  it("a malformed escape in the query is nobody's business", async () => {
    expect((await request(app).get("/health?x=%zz")).status).toBe(200);
  });

  it.each(["/", "/nope", "/health", "/api/agent/health", "/api/agent/v1/anything/", "/api/agent/swagger/"])(
    "OPTIONS %s is a 204 with the four CORS headers and nothing else",
    async (path) => {
      const { app: a, centre } = createTestApp();
      const res = await request(a).options(path).set("Origin", "https://evil.example.test").set("Authorization", "Bearer hang");
      expect(res.status).toBe(204);
      expect(res.text).toBe("");
      expect(res.headers["content-type"]).toBeUndefined();
      expect(res.headers).toMatchObject(CORS);
      for (const absent of ["vary", "access-control-allow-credentials", "access-control-max-age"]) expect(res.headers[absent]).toBeUndefined();
      expect(centre.asked).toEqual([]);
    },
  );

  it("CORS_ALLOWED_ORIGIN is used verbatim, not matched against Origin", async () => {
    const { app: a } = createTestApp({ corsAllowedOrigin: "*" });
    expect((await request(a).get("/health").set("Origin", "https://x.test")).headers["access-control-allow-origin"]).toBe("*");
  });
});

describe("request targets in absolute form", () => {
  // supertest cannot send "GET http://host/path", so this speaks HTTP over a socket.
  async function raw(target: string): Promise<string> {
    const { app } = createTestApp();
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const { port } = server.address() as import("node:net").AddressInfo;
    try {
      return await new Promise<string>((resolve, reject) => {
        const socket = net.connect(port, "127.0.0.1", () => socket.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
        let data = "";
        socket.on("data", (c) => (data += c));
        socket.on("end", () => resolve(data));
        socket.on("error", reject);
      });
    } finally {
      server.close();
    }
  }

  it("are routed on their path, as Go does", async () => {
    expect(await raw("http://example.test:81/health")).toMatch(/^HTTP\/1\.1 200 /);
    expect(await raw("http://example.test/api/agent//health")).toMatch(/^HTTP\/1\.1 301 [\s\S]*\r\nLocation: \/api\/agent\/health\r\n/i);
    expect(await raw("http://example.test/api/agent/nope")).toMatch(/^HTTP\/1\.1 404 /);
    expect(await raw("http://h#f")).toMatch(/^HTTP\/1\.1 400 /);
    expect(await raw("http://example.test/x#f")).toMatch(/^HTTP\/1\.1 405 /);
    expect(await raw("http://example.test")).toMatch(/^HTTP\/1\.1 301 [\s\S]*\r\nLocation: \/\r\n/i);
  });
});

describe("every route is declared, or the service refuses to start", () => {
  const auth = () => createExpressAuth(stubCentre().introspector);

  it("the real routes all have a policy entry (startup succeeds)", () => {
    expect(() => createApp({ corsAllowedOrigin: TEST_ORIGIN, gateway: noGateway, auth: auth() })).not.toThrow();
  });

  it("a route with no entry in the policy table refuses startup", () => {
    expect(() =>
      createApp({
        corsAllowedOrigin: TEST_ORIGIN,
        gateway: noGateway,
        auth: auth(),
        registerRoutes: (r) => (r["get"] as (p: string, h: unknown) => void)("/api/agent/v1/undeclared", () => undefined),
      }),
    ).toThrow(/GET \/api\/agent\/v1\/undeclared declares no credential requirement/);
  });

  it("a route registered straight on the app, bypassing the table, refuses startup (clerk-client's secured())", () => {
    expect(() =>
      createApp({
        corsAllowedOrigin: TEST_ORIGIN,
        gateway: noGateway,
        auth: auth(),
        registerRoutes: (_registrar, app) => {
          app.get("/sneaky", (_req, res) => res.end());
        },
      }),
    ).toThrow(/without an authorization declaration/);
  });

  it("an unauthenticated mutation refuses startup: POST declared 'none' or 'ignore'", () => {
    for (const tier of ["none", "ignore"]) {
      expect(() =>
        createApp({
          corsAllowedOrigin: TEST_ORIGIN,
        gateway: noGateway,
          auth: auth(),
          policy: { ...routePolicy, "POST /x": tier },
          registerRoutes: (r) => (r["post"] as (p: string, h: unknown) => void)("/x", () => undefined),
        }),
      ).toThrow(/mutating method but declares no session or scope/);
    }
  });

  it("a declared route is enforced: 'session' is a 401 without a credential and never reaches its handler", async () => {
    const { app } = createTestApp({
      policy: { ...routePolicy, "GET /api/agent/v1/probe": "session" },
      registerRoutes: (r) =>
        (r["get"] as (p: string, h: unknown) => void)("/api/agent/v1/probe", (_q: unknown, s: express.Response) => s.json({ reached: true })),
    });
    const res = await request(app).get("/api/agent/v1/probe");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: { message: "a bearer token is required" } });
    expect(res.headers["content-type"]).toBe("application/json");
    expect(res.headers).toMatchObject(CORS);
  });

  describe("a scope tier is enforced", () => {
    const route = (scopes: string[] | null) => {
      const centre = stubCentre(scopes === null ? { state: "inactive" } : { state: "active", identity: { sub: "u", kind: "operator", scopes } });
      let reached = 0;
      const { app } = createTestApp(
        {
          policy: { ...routePolicy, "POST /api/agent/v1/probe": "fleet:control" },
          registerRoutes: (r) =>
            (r["post"] as (p: string, h: unknown) => void)("/api/agent/v1/probe", (_q: unknown, s: express.Response) => {
              reached++;
              s.json({ reached: true });
            }),
        },
        centre,
      );
      return { app, centre, reached: () => reached };
    };

    it("no credential: 401, the handler is not reached, the centre is not asked", async () => {
      const { app, centre, reached } = route(["fleet:control"]);
      const res = await request(app).post("/api/agent/v1/probe");
      expect([res.status, res.body]).toEqual([401, { error: { message: "a bearer token is required" } }]);
      expect([reached(), centre.asked]).toEqual([0, []]);
    });

    it("a session without the scope: 403 in the envelope, handler not reached", async () => {
      const { app, reached } = route(["other"]);
      const res = await request(app).post("/api/agent/v1/probe").set("Authorization", "Bearer t");
      expect([res.status, res.body]).toEqual([403, { error: { message: "this action requires a scope this session does not carry" } }]);
      expect(res.headers["content-type"]).toBe("application/json");
      expect(reached()).toBe(0);
    });

    it("an inactive token: 401 invalid or expired session", async () => {
      const { app } = route(null);
      const res = await request(app).post("/api/agent/v1/probe").set("Authorization", "Bearer t");
      expect([res.status, res.body]).toEqual([401, { error: { message: "invalid or expired session" } }]);
    });

    it("a session with the scope reaches the handler, and the centre is asked once", async () => {
      const { app, centre, reached } = route(["x", "fleet:control"]);
      const res = await request(app).post("/api/agent/v1/probe").set("Authorization", "Bearer t");
      expect([res.status, res.body, reached(), centre.asked]).toEqual([200, { reached: true }, 1, ["t"]]);
    });
  });

  it("the registrar hands the declaration to Express as the first handler", () => {
    const calls: unknown[][] = [];
    const reg = declaring({ get: (...a: unknown[]) => calls.push(a) }, auth(), { "GET /a": "session" });
    (reg["get"] as (...a: unknown[]) => void)("/a", "handler");
    expect(calls).toHaveLength(1);
    expect(typeof calls[0]?.[1]).toBe("function");
    expect(calls[0]?.[2]).toBe("handler");
  });
});
