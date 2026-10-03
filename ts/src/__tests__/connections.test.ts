import net from "node:net";
import type { AddressInfo } from "node:net";
import { createExpressAuth } from "@v-m-pioneer-trading/clerk-client";
import { HistoryStore } from "../db/history";
import { createHttpServer } from "../server";
import { FakeSql } from "../testSupport/fakeSql";
import { createTestApp, stubCentre } from "../testSupport/createTestApp";

jest.setTimeout(30000);

const WRITER = { state: "active", identity: { sub: "u", kind: "operator", scopes: ["fleet:control"] } } as const;

async function listen(identity: Parameters<typeof stubCentre>[0]) {
  const { app } = createTestApp({ history: new HistoryStore(new FakeSql()) }, stubCentre(identity));
  const server = createHttpServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as AddressInfo).port };
}

/** Sends `head`, then `chunk` every 5 ms until the server closes the connection; reports what it said and how long it took. */
function flood(port: number, head: string, chunk: string) {
  return new Promise<{ status: string; closedAfterMs: number; sent: number }>((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    const t0 = Date.now();
    let received = "";
    let sent = 0;
    const timer = setInterval(() => {
      if (socket.destroyed) return;
      sent += chunk.length;
      socket.write(chunk, () => undefined);
    }, 5);
    socket.on("error", () => undefined);
    socket.on("data", (d) => (received += d.toString("latin1")));
    socket.on("close", () => {
      clearInterval(timer);
      resolve({ status: received.split("\r\n", 1)[0] ?? "", closedAfterMs: Date.now() - t0, sent });
    });
    socket.write(head);
  });
}
const CHUNKED = (path: string) => `POST ${path} HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\nAuthorization: Bearer t\r\n\r\n`;
const chunk = `10000\r\n${"a".repeat(0x10000)}\r\n`;

describe("an answer that leaves the request body unread closes the connection", () => {
  it("an endless chunked body to a write route: the 400 for a body over 1 MiB, then closed within a second", async () => {
    const { server, port } = await listen(WRITER);
    const r = await flood(port, CHUNKED("/api/agent/v1/ships/purchase"), chunk);
    expect(r.status).toBe("HTTP/1.1 400 Bad Request");
    expect(r.closedAfterMs).toBeLessThan(3000);
    server.close();
  });

  it("the same to a route that answers 401 before reading anything", async () => {
    const { server, port } = await listen({ state: "inactive" });
    const r = await flood(port, CHUNKED("/api/agent/v1/ships/purchase"), chunk);
    expect(r.status).toBe("HTTP/1.1 401 Unauthorized");
    expect(r.closedAfterMs).toBeLessThan(3000);
    expect(r.sent).toBeLessThan(64 << 20);
    server.close();
  });

  it("and to a route that does not read a body at all (accept), once it has answered", async () => {
    const { server, port } = await listen(WRITER);
    const r = await flood(port, CHUNKED("/api/agent/v1/contracts/C/accept"), chunk);
    expect(r.closedAfterMs).toBeLessThan(3000);
    server.close();
  });

  it("a body that did arrive in full keeps the connection: two requests on one socket", async () => {
    const { server, port } = await listen({ state: "inactive" });
    const answers = await new Promise<string>((resolve) => {
      const s = net.connect(port, "127.0.0.1");
      let got = "";
      s.on("data", (d) => {
        got += d.toString();
        if ((got.match(/HTTP\/1\.1 401/g) ?? []).length === 2) {
          s.destroy();
          resolve(got);
        }
      });
      const req = "POST /api/agent/v1/ships/purchase HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\n\r\n{}";
      s.write(req + req);
    });
    expect((answers.match(/HTTP\/1\.1 401/g) ?? []).length).toBe(2);
    server.close();
  });
});

describe("the header timeout is 10 s, checked every second", () => {
  it("is configured so", async () => {
    const { server } = await listen(WRITER);
    expect([server.headersTimeout, server.requestTimeout, server.keepAliveTimeout]).toEqual([10_000, 30_000, 120_000]);
    server.close();
  });

  it("slow headers are cut off at about 10 s, not 30 or more", async () => {
    const { server, port } = await listen(WRITER);
    const t0 = Date.now();
    let got = "";
    const closed = await new Promise<number>((resolve) => {
      const s = net.connect(port, "127.0.0.1");
      s.on("close", () => resolve(Date.now() - t0));
      s.on("data", (d) => (got += d.toString()));
      s.write("GET /health HTTP/1.1\r\nHost: x\r\n");
    });
    expect(closed).toBeGreaterThanOrEqual(9000);
    expect(closed).toBeLessThan(14000);
    expect(got).toBe(""); // closed, not answered with a 408
    server.close();
  });
});

/** An auth centre that answers after about 20 ms, as the real one does. */
async function listenSlowCentre(answer: Parameters<typeof stubCentre>[0]) {
  const centre = stubCentre(answer);
  const slow = { introspect: async (token: string) => (await new Promise((r) => setTimeout(r, 20)), centre.introspector.introspect(token)) };
  const { app } = createTestApp({ history: new HistoryStore(new FakeSql()), auth: createExpressAuth(slow as never) }, centre);
  const server = createHttpServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as AddressInfo).port };
}

/** Writes `parts` in order, waits for `until` to be true of what came back (or the socket to close), and reports it. */
function exchange(port: number, parts: Array<string | number>, until: (got: string) => boolean, limitMs = 5000) {
  return new Promise<{ got: string; ms: number; closed: boolean }>((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    const t0 = Date.now();
    let got = "";
    let done = false;
    const finish = (closed: boolean): void => {
      if (done) return;
      done = true;
      s.destroy();
      resolve({ got, ms: Date.now() - t0, closed });
    };
    s.on("error", () => undefined);
    s.on("data", (d) => {
      got += d.toString("latin1");
      if (until(got)) finish(false);
    });
    s.on("close", () => finish(true));
    setTimeout(() => finish(false), limitMs).unref();
    void (async () => {
      for (const p of parts) {
        if (typeof p === "number") await new Promise((r) => setTimeout(r, p));
        else s.write(p, "latin1");
      }
    })();
  });
}
const BODY_200K = "x".repeat(200_000);
const POST = (path: string, length: number) => `POST ${path} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer t\r\nContent-Length: ${length}\r\n\r\n`;

describe("an unread body does not wedge the connection (other callers share it behind a proxy)", () => {
  it.each([
    ["a 401 route", { state: "inactive" } as const, "/api/agent/v1/ships/purchase"],
    ["accept", WRITER, "/api/agent/v1/contracts/C/accept"],
  ])("200 KB sent to %s, then a second request on the same socket: answered within a second, no 408 anywhere", async (_n, identity, path) => {
    const { server, port } = await listenSlowCentre(identity);
    const r = await exchange(port, [POST(path, 200_000) + BODY_200K, "GET /health HTTP/1.1\r\nHost: x\r\n\r\n"], (g) => g.includes('"status":"ok"'), 3000);
    expect(r.got).toContain('"status":"ok"');
    expect(r.ms).toBeLessThan(1000);
    expect(r.got).not.toContain("408");
    server.close();
  });

  it("a partial body and then silence: closed at about a second, with no 408", async () => {
    const { server, port } = await listenSlowCentre({ state: "inactive" });
    const r = await exchange(port, [POST("/api/agent/v1/ships/purchase", 100_000) + "x".repeat(1000)], () => false, 6000);
    expect(r.closed).toBe(true);
    expect(r.got.split("\r\n", 1)[0]).toBe("HTTP/1.1 401 Unauthorized");
    expect(r.ms).toBeGreaterThanOrEqual(900);
    expect(r.ms).toBeLessThan(3500);
    expect(r.got).not.toContain("408");
    server.close();
  });

  it("an endless body to a slow-centre 401 closes fast", async () => {
    const { server, port } = await listenSlowCentre({ state: "inactive" });
    const r = await flood(port, CHUNKED("/api/agent/v1/ships/purchase"), chunk);
    expect(r.status).toBe("HTTP/1.1 401 Unauthorized");
    expect(r.closedAfterMs).toBeLessThan(3000);
    server.close();
  });
});

describe("Expect: 100-continue", () => {
  const head = (path: string) => `POST ${path} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer t\r\nExpect: 100-continue\r\nContent-Length: 2\r\n\r\n`;

  it("is not answered with 100 before auth: a refused caller is told 401 and uploads nothing", async () => {
    const { server, port } = await listenSlowCentre({ state: "inactive" });
    const r = await exchange(port, [head("/api/agent/v1/ships/purchase")], (g) => g.includes("401"), 3000);
    expect(r.got).not.toContain("100 Continue");
    expect(r.got).toContain("HTTP/1.1 401");
    server.close();
  });

  it("is answered with 100 when the handler starts reading the body, and then the body is used", async () => {
    const { server, port } = await listenSlowCentre(WRITER);
    const r = await exchange(port, [head("/api/agent/v1/ships/purchase"), 200, "{}"], (g) => g.includes("shipType and waypointSymbol are required"), 3000);
    expect(r.got.startsWith("HTTP/1.1 100 Continue")).toBe(true);
    expect(r.got).toContain("HTTP/1.1 400 Bad Request");
    expect(r.got).toContain("shipType and waypointSymbol are required");
    server.close();
  });
});

describe("a client that is too slow is closed, not answered", () => {
  it("a malformed request still gets a 400, and an oversized header a 431", async () => {
    const { server, port } = await listenSlowCentre(WRITER);
    expect((await exchange(port, ["GARBAGE\r\n\r\n"], (g) => g.includes("\r\n\r\n"), 2000)).got).toMatch(/^HTTP\/1.1 400 Bad Request/);
    expect((await exchange(port, [`GET /health HTTP/1.1\r\nHost: x\r\nX: ${"a".repeat(100_000)}\r\n\r\n`], (g) => g.includes("\r\n\r\n"), 2000)).got).toMatch(/^HTTP\/1.1 431/);
    server.close();
  });
});
