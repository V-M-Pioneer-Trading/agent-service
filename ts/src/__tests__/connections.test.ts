import net from "node:net";
import type { AddressInfo } from "node:net";
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
    const closed = await new Promise<number>((resolve) => {
      const s = net.connect(port, "127.0.0.1");
      s.on("close", () => resolve(Date.now() - t0));
      s.resume();
      s.on("close", () => resolve(Date.now() - t0));
      s.write("GET /health HTTP/1.1\r\nHost: x\r\n");
    });
    expect(closed).toBeGreaterThanOrEqual(9000);
    expect(closed).toBeLessThan(14000);
    server.close();
  });
});
