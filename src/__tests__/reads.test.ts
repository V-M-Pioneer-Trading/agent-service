import http from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { GatewayClient, MAX_REQUESTS } from "../gateway/client";
import { createTestApp, stubCentre } from "../testSupport/createTestApp";

/** A scripted st-gateway: records every request, answers by "METHOD target". */
interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
}
type Reply = { status?: number; body?: string; headers?: Record<string, string>; delay?: number };

jest.setTimeout(20000);

const servers: http.Server[] = [];
afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
});

async function gateway(script: Record<string, Reply>) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
    const reply = script[`${req.method} ${req.url}`];
    res.statusCode = reply?.status ?? (reply === undefined ? 599 : 200);
    for (const [k, v] of Object.entries(reply?.headers ?? {})) res.setHeader(k, v);
    setTimeout(() => res.end(reply?.body ?? (reply === undefined ? "nothing scripted" : "")), reply?.delay ?? 0);
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, seen };
}

const OPERATOR = { state: "active", identity: { sub: "u", kind: "operator", scopes: [] } } as const;
const SESSION = "Bearer   a-session";
async function appWith(script: Record<string, Reply>) {
  const gw = await gateway(script);
  const { app, centre } = createTestApp({ gateway: new GatewayClient(`${gw.url}/proxy`) }, stubCentre(OPERATOR));
  return { app, centre, seen: gw.seen, url: gw.url };
}

const agent = '{"data":{"accountId":"A","symbol":"S","headquarters":"H","credits":9007199254740993,"startingFaction":"F","shipCount":3},"meta":{"total":1}}';
const agentOut = '{"accountId":"A","symbol":"S","headquarters":"H","credits":9007199254740993,"startingFaction":"F","shipCount":3}';

describe("GET /api/agent/v1/agent", () => {
  it("answers the decoded agent, int64 exact, as Go's JSON, and asks the gateway on the caller's own header", async () => {
    const { app, seen } = await appWith({ "GET /proxy/my/agent": { body: agent } });
    const res = await request(app).get("/api/agent/v1/agent").set("Authorization", SESSION);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");
    expect(res.text).toBe(`${agentOut}\n`);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers["authorization"]).toBe(SESSION);
    expect(seen[0]?.headers["content-type"]).toBeUndefined();
    expect(seen[0]?.headers["cookie"]).toBeUndefined();
  });

  it("is a 401 for a visitor, and the gateway is never called", async () => {
    const { app, seen } = await appWith({});
    expect((await request(app).get("/api/agent/v1/agent")).status).toBe(401);
    expect(seen).toEqual([]);
  });

  it("an empty answer is the zero agent", async () => {
    const { app } = await appWith({ "GET /proxy/my/agent": { status: 204 } });
    const res = await request(app).get("/api/agent/v1/agent").set("Authorization", SESSION);
    expect(res.text).toBe('{"accountId":"","symbol":"","headquarters":"","credits":0,"startingFaction":"","shipCount":0}\n');
  });

  it.each([["5.0"], ["1e3"], ["9223372036854775808"], ['"5"']])("credits %s does not fit: 502, text/plain", async (credits) => {
    const { app } = await appWith({ "GET /proxy/my/agent": { body: `{"data":{"credits":${credits}}}` } });
    const res = await request(app).get("/api/agent/v1/agent").set("Authorization", SESSION);
    expect(res.status).toBe(502);
    expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(res.text.length).toBeGreaterThan(1);
  });

  it("whitespace only is a 502", async () => {
    const { app } = await appWith({ "GET /proxy/my/agent": { body: " \n" } });
    expect((await request(app).get("/api/agent/v1/agent").set("Authorization", SESSION)).status).toBe(502);
  });

  it("HEAD is GET without the body", async () => {
    const { app, seen } = await appWith({ "GET /proxy/my/agent": { body: agent } });
    const res = await request(app).head("/api/agent/v1/agent").set("Authorization", SESSION);
    expect(res.status).toBe(200);
    expect(res.text ?? "").toBe("");
    expect(seen.map((s) => s.method)).toEqual(["GET"]);
  });
});

describe("upstream errors", () => {
  it("relays the gateway's status, sentence and pacing headers, nothing else of its headers", async () => {
    const { app } = await appWith({
      "GET /proxy/my/agent": { status: 429, body: '{"error":{"message":"slow down"}}', headers: { "Retry-After": "7", "X-RateLimit-Remaining": "0", "X-Other": "no" } },
    });
    const res = await request(app).get("/api/agent/v1/agent").set("Authorization", SESSION);
    expect([res.status, res.text]).toEqual([429, "slow down\n"]);
    expect(res.headers["retry-after"]).toBe("7");
    expect(res.headers["x-ratelimit-remaining"]).toBe("0");
    expect(res.headers["x-other"]).toBeUndefined();
    expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
  });

  it("a dead gateway is a 504 that names no address", async () => {
    const dead = await gateway({});
    await new Promise((r) => servers.pop()?.close(r));
    const { app } = createTestApp({ gateway: new GatewayClient(`${dead.url}/proxy`) }, stubCentre(OPERATOR));
    const res = await request(app).get("/api/agent/v1/ships").set("Authorization", SESSION);
    expect([res.status, res.text]).toEqual([504, "st-gateway did not answer\n"]);
  });
});

describe("GET /api/agent/v1/ships and /contracts", () => {
  it("a missing or null data member is null, an empty list is [], meta is dropped but must fit", async () => {
    const { app } = await appWith({
      "GET /proxy/my/ships": { body: '{"meta":{"total":0}}' },
      "GET /proxy/my/contracts": { body: '{"data":[],"meta":{"total":"x"}}' },
    });
    const ships = await request(app).get("/api/agent/v1/ships").set("Authorization", SESSION);
    expect([ships.status, ships.text]).toEqual([200, "null\n"]);
    expect((await request(app).get("/api/agent/v1/contracts").set("Authorization", SESSION)).status).toBe(502);
  });

  it("a ship comes back whole, lists null, times normalised, unknown members dropped", async () => {
    const { app } = await appWith({
      "GET /proxy/my/ships": { body: '{"data":[{"SYMBOL":"S1","extra":1,"cooldown":{"expiration":"2026-01-02T03:04:05.120+02:00"},"cargo":{"units":2}}]}' },
    });
    const res = await request(app).get("/api/agent/v1/ships").set("Authorization", SESSION);
    const [ship] = JSON.parse(res.text) as Array<Record<string, any>>;
    expect(ship?.symbol).toBe("S1");
    expect(ship?.extra).toBeUndefined();
    expect(ship?.cooldown).toEqual({ shipSymbol: "", totalSeconds: 0, remainingSeconds: 0, expiration: "2026-01-02T03:04:05.12+02:00" });
    expect(ship?.modules).toBeNull();
    expect(ship?.cargo).toEqual({ capacity: 0, units: 2, inventory: null });
    expect(ship?.nav.route.arrival).toBe("0001-01-01T00:00:00Z");
  });

  it("a contract with a bad time is a 502", async () => {
    const { app } = await appWith({ "GET /proxy/my/contracts/C1": { body: '{"data":{"id":"C1","expiration":"2026-12-31T23:59:60Z"}}' } });
    expect((await request(app).get("/api/agent/v1/contracts/C1").set("Authorization", SESSION)).status).toBe(502);
  });
});

describe("path symbols", () => {
  it.each([
    ["A%20B", "A%20B"],
    ["a%26b%24c%2Bd", "a&b$c+d"],
    ["a%2Cb%3Bc%3Fd%23e%25f", "a%2Cb%3Bc%3Fd%23e%25f"],
    ["%C3%A9", "%C3%A9"],
    ["%FF%fe", "%FF%FE"],
    ["%7E", "~"],
  ])("%s is asked of the gateway as %s", async (sent, upstream) => {
    const { app, seen } = await appWith({ [`GET /proxy/my/ships/${upstream}`]: { body: '{"data":{"symbol":"X"}}' }, [`GET /proxy/my/contracts/${upstream}`]: { body: '{"data":{"id":"X"}}' } });
    expect((await request(app).get(`/api/agent/v1/ships/${sent}`).set("Authorization", SESSION)).status).toBe(200);
    expect((await request(app).get(`/api/agent/v1/contracts/${sent}`).set("Authorization", SESSION)).status).toBe(200);
    expect(seen).toHaveLength(2);
  });
});

describe("GET /api/agent/v1/current-agent", () => {
  it("asks agent, ships, contracts in that order and bundles them", async () => {
    const { app, seen, centre } = await appWith({
      "GET /proxy/my/agent": { body: agent },
      "GET /proxy/my/ships": { body: '{"data":[]}' },
      "GET /proxy/my/contracts": { body: "" },
    });
    const res = await request(app).get("/api/agent/v1/current-agent").set("Authorization", SESSION);
    expect(res.text).toBe(`{"agent":${agentOut},"ships":[],"contracts":null}\n`);
    expect(seen.map((s) => s.url)).toEqual(["/proxy/my/agent", "/proxy/my/ships", "/proxy/my/contracts"]);
    expect(centre.asked).toHaveLength(1);
  });

  it("stops at the first failure, and a bad third answer discards the first two", async () => {
    const first = await appWith({ "GET /proxy/my/agent": { status: 418, body: '{"error":{"message":"teapot"}}' } });
    expect((await request(first.app).get("/api/agent/v1/current-agent").set("Authorization", SESSION)).status).toBe(418);
    expect(first.seen).toHaveLength(1);
    const third = await appWith({ "GET /proxy/my/agent": { body: agent }, "GET /proxy/my/ships": { body: "{}" }, "GET /proxy/my/contracts": { body: "<html>" } });
    const res = await request(third.app).get("/api/agent/v1/current-agent").set("Authorization", SESSION);
    expect(res.status).toBe(502);
    expect(res.text).not.toContain("accountId");
  });
});

describe("redirects from the gateway", () => {
  it("are followed with the Authorization header", async () => {
    const { app, seen } = await appWith({ "GET /proxy/my/agent": { status: 302, headers: { Location: "/proxy/moved" } }, "GET /proxy/moved": { body: agent } });
    const res = await request(app).get("/api/agent/v1/agent").set("Authorization", SESSION);
    expect(res.status).toBe(200);
    expect(seen[1]?.headers["authorization"]).toBe(SESSION);
  });

  it("stop after ten requests: 504", async () => {
    const { app, seen } = await appWith({ "GET /proxy/my/agent": { status: 302, headers: { Location: "/proxy/my/agent" } } });
    const res = await request(app).get("/api/agent/v1/agent").set("Authorization", SESSION);
    expect([res.status, res.text]).toEqual([504, "st-gateway did not answer\n"]);
    expect(seen).toHaveLength(MAX_REQUESTS);
  });

  it("a redirect without a Location is the answer itself; a 300 or 304 is never followed", async () => {
    const { app, seen } = await appWith({ "GET /proxy/my/agent": { status: 301, body: "" }, "GET /proxy/my/ships": { status: 304, headers: { Location: "/x" } } });
    expect((await request(app).get("/api/agent/v1/agent").set("Authorization", SESSION)).status).toBe(200);
    expect((await request(app).get("/api/agent/v1/ships").set("Authorization", SESSION)).text).toBe("null\n");
    expect(seen).toHaveLength(2);
  });

  it("do not carry Authorization to another host", async () => {
    const other = await gateway({ "GET /elsewhere": { body: agent } });
    const to = `http://localhost:${new URL(other.url).port}/elsewhere`;
    const { app } = await appWith({ "GET /proxy/my/agent": { status: 307, headers: { Location: to } } });
    expect((await request(app).get("/api/agent/v1/agent").set("Authorization", SESSION)).status).toBe(200);
    expect(other.seen[0]?.headers["authorization"]).toBeUndefined();
  });

  it("a Location that is no URL is a 504", async () => {
    const { app } = await appWith({ "GET /proxy/my/agent": { status: 302, headers: { Location: "http://[bad" } } });
    expect((await request(app).get("/api/agent/v1/agent").set("Authorization", SESSION)).status).toBe(504);
  });
});

describe("answers Go cannot encode, and answers too big for one string", () => {
  it("a zone offset of a day or more is read but cannot be written: 200, application/json, no body", async () => {
    const { app } = await appWith({ "GET /proxy/my/contracts/C1": { body: '{"data":{"id":"C1","expiration":"2026-01-02T03:04:05+24:00"}}' } });
    const res = await request(app).get("/api/agent/v1/contracts/C1").set("Authorization", SESSION);
    expect([res.status, res.headers["content-type"], res.text]).toEqual([200, "application/json", ""]);
  });

  it("a lenient time is normalised, and the offset recomputed", async () => {
    const { app } = await appWith({ "GET /proxy/my/contracts/C1": { body: '{"data":{"expiration":"2026-01-02T3:04:05,5+00:60"}}' } });
    const res = await request(app).get("/api/agent/v1/contracts/C1").set("Authorization", SESSION);
    expect(JSON.parse(res.text).expiration).toBe("2026-01-02T03:04:05.5+01:00");
  });

  it("a long list goes out in pieces, whole", async () => {
    const items = Array.from({ length: 30000 }, (_, k) => `{"symbol":"S${k}","registration":{"name":"${"x".repeat(60)}"}}`).join(",");
    const { app } = await appWith({ "GET /proxy/my/ships": { body: `{"data":[${items}]}` } });
    const res = await request(app).get("/api/agent/v1/ships").set("Authorization", SESSION);
    expect(res.status).toBe(200);
    expect(res.text.length).toBeGreaterThan(3 << 20);
    const ships = JSON.parse(res.text) as Array<{ symbol: string }>;
    expect(ships).toHaveLength(30000);
    expect(ships[29999]?.symbol).toBe("S29999");
  });
});

describe("a caller who hangs up", () => {
  it("stops /current-agent before its remaining calls", async () => {
    const { app, seen } = await appWith({
      "GET /proxy/my/agent": { body: agent, delay: 200 },
      "GET /proxy/my/ships": { body: '{"data":[]}' },
      "GET /proxy/my/contracts": { body: "" },
    });
    const server = http.createServer(app);
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>((resolve) => {
      const req = http.get({ port, host: "127.0.0.1", path: "/api/agent/v1/current-agent", headers: { Authorization: SESSION } });
      req.on("error", () => undefined);
      const poll = setInterval(() => {
        if (seen.length === 0) return;
        clearInterval(poll);
        req.destroy();
        setTimeout(resolve, 500);
      }, 5);
    });
    expect(seen.map((x) => x.url)).toEqual(["/proxy/my/agent"]);
  });
});
