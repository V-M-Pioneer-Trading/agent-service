import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { ASSETS } from "../swagger";
import { HistoryStore } from "../db/history";
import { GatewayClient } from "../gateway/client";
import { FakeSql } from "../testSupport/fakeSql";
import { createTestApp, stubCentre } from "../testSupport/createTestApp";

/** A scripted st-gateway: records every request in full, answers by "METHOD target". */
interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}
interface Reply { status?: number; body?: string; headers?: Record<string, string> }

const servers: http.Server[] = [];
beforeAll(() => {
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});
afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
});

async function gateway(script: Record<string, Reply | "hangup">) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    const chunks: Buffer[] = [];
    req.on("data", (d: Buffer) => chunks.push(d));
    req.on("end", () => {
      body = Buffer.concat(chunks).toString("utf8");
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      const reply = script[`${String(req.method)} ${String(req.url)}`];
      if (reply === "hangup") {
        req.socket.destroy();
        return;
      }
      res.statusCode = reply?.status ?? (reply === undefined ? 599 : 200);
      for (const [k, v] of Object.entries(reply?.headers ?? {})) res.setHeader(k, v);
      res.end(reply?.body ?? (reply === undefined ? "nothing scripted" : ""));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, seen };
}

const WRITER = { state: "active", identity: { sub: "u", kind: "operator", scopes: ["fleet:control"] } } as const;
const READER = { state: "active", identity: { sub: "u", kind: "operator", scopes: [] } } as const;
const SESSION = "Bearer   a-session";

async function appWith(script: Record<string, Reply | "hangup">, sql = new FakeSql(), identity: typeof WRITER | typeof READER = WRITER) {
  const gw = await gateway(script);
  const errors: string[] = [];
  const { app, centre } = createTestApp(
    { gateway: new GatewayClient(`${gw.url}/proxy`), history: new HistoryStore(sql), errorLog: (l) => void errors.push(l) },
    stubCentre(identity),
  );
  return { app, centre, seen: gw.seen, sql, errors, url: gw.url };
}

const AGENT = '{"accountId":"A","symbol":"S","headquarters":"H","credits":9007199254740993,"startingFaction":"F","shipCount":3}';
const CONTRACT =
  '{"id":"C-1","factionSymbol":"COSMIC","type":"PROCUREMENT","terms":{"deadline":"2026-03-04T05:06:07Z","payment":{"onAccepted":10,"onFulfilled":20},"deliver":[{"tradeSymbol":"IRON","destinationSymbol":"X1-A","unitsRequired":5,"unitsFulfilled":0}]},"accepted":true,"fulfilled":false,"expiration":"2026-03-04T05:06:07Z","deadlineToAccept":"2026-03-04T05:06:07Z"}';
const CONTRACT_AND_AGENT = `{"agent":${AGENT},"contract":${CONTRACT}}`;
const CARGO = '{"capacity":10,"units":1,"inventory":[]}';
const TRADE = (stamp = "2026-03-04T05:06:07Z") =>
  `{"waypointSymbol":"X1-A","shipSymbol":"FROM-ANSWER","tradeSymbol":"IRON","type":"SELL","units":4,"pricePerUnit":25,"totalPrice":100,"timestamp":"${stamp}"}`;
const MARKET = `{"agent":${AGENT},"cargo":${CARGO},"transaction":${TRADE()}}`;
const SHIP_TX = '{"waypointSymbol":"X1-C","shipType":"SHIP_PROBE","price":55000,"agentSymbol":"A","timestamp":"2026-03-04T05:06:07Z"}';
const PURCHASE = `{"agent":${AGENT},"ship":{"symbol":"NEW-1"},"transaction":${SHIP_TX}}`;

const ok = (data: string): Reply => ({ body: `{"data":${data}}` });
const post = (app: Parameters<typeof request>[0], path: string, body?: string) => {
  const r = request(app).post(path).set("Authorization", SESSION);
  return body === undefined ? r : r.set("Content-Type", "application/json").send(body);
};

const ROUTES = [
  { name: "accept", path: "/api/agent/v1/contracts/C-1/accept", body: undefined },
  { name: "fulfill", path: "/api/agent/v1/contracts/C-1/fulfill", body: undefined },
  { name: "purchase ship", path: "/api/agent/v1/ships/purchase", body: '{"shipType":"T","waypointSymbol":"W"}' },
  { name: "purchase cargo", path: "/api/agent/v1/ships/S-1/purchase", body: '{"symbol":"IRON","units":4}' },
  { name: "sell cargo", path: "/api/agent/v1/ships/S-1/sell", body: '{"symbol":"IRON","units":4}' },
  { name: "record delivery", path: "/api/agent/v1/contracts/C-1/deliveries", body: '{"shipSymbol":"S","tradeSymbol":"T","units":2}' },
];

describe("the six writes are fleet:control routes", () => {
  it.each(ROUTES)("$name: no credential is a 401, a session without the scope is a 403, and nothing is called or written", async ({ path, body }) => {
    const { app, seen, sql, centre } = await appWith({}, new FakeSql(), READER);
    const visitor = await request(app).post(path).send(body);
    expect([visitor.status, visitor.body]).toEqual([401, { error: { message: "a bearer token is required" } }]);
    const noScope = await post(app, path, body);
    expect([noScope.status, noScope.body]).toEqual([403, { error: { message: "this action requires a scope this session does not carry" } }]);
    expect(noScope.headers["content-type"]).toBe("application/json");
    expect(seen).toEqual([]);
    expect(sql.calls).toEqual([]);
    expect(centre.asked).toEqual(["a-session"]);
  });

  it.each(ROUTES)("$name: an unparseable body with no session is a 401, with a scopeless session a 403 (auth runs before the body)", async ({ path }) => {
    const { app } = await appWith({}, new FakeSql(), READER);
    expect((await request(app).post(path).send("{not json")).status).toBe(401);
    expect((await post(app, path, "{not json")).status).toBe(403);
  });
});

describe("POST /contracts/{id}/accept and /fulfill", () => {
  it.each([["accept"], ["fulfill"]])("%s: calls the gateway with no body and no Content-Type, answers the decoded result, records the contract", async (action) => {
    const { app, seen, sql, centre } = await appWith({ [`POST /proxy/my/contracts/C-1/${action}`]: ok(CONTRACT_AND_AGENT) });
    const res = await post(app, `/api/agent/v1/contracts/C-1/${action}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");
    expect(res.text).toBe(`${CONTRACT_AND_AGENT}\n`);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.body).toBe("");
    expect(seen[0]?.headers["content-type"]).toBeUndefined();
    expect(seen[0]?.headers.authorization).toBe(SESSION);
    expect(centre.asked).toEqual(["a-session"]);
    expect(sql.calls).toHaveLength(1);
    expect(sql.calls[0]?.sql).toContain("INSERT INTO contracts");
    expect(sql.calls[0]?.params.slice(0, 5)).toEqual(["C-1", "COSMIC", "PROCUREMENT", 1, 0]);
  });

  it("reads no body at all: a body that is not JSON, or huge, changes nothing", async () => {
    const { app, seen } = await appWith({ "POST /proxy/my/contracts/C-1/accept": ok(CONTRACT_AND_AGENT) });
    const res = await post(app, "/api/agent/v1/contracts/C-1/accept", "{not json" + "x".repeat(200_000));
    expect(res.status).toBe(200);
    expect(seen[0]?.body).toBe("");
  });

  it("the id goes to the gateway as the router decoded it, escaped like url.PathEscape", async () => {
    const { app, seen, sql } = await appWith({ "POST /proxy/my/contracts/a%20b%C3%A9%25/accept": ok(CONTRACT_AND_AGENT) });
    const res = await post(app, "/api/agent/v1/contracts/a%20b%C3%A9%25/accept");
    expect(res.status).toBe(200);
    expect(seen[0]?.url).toBe("/proxy/my/contracts/a%20b%C3%A9%25/accept");
    // The row is keyed by the contract's id from the answer, not the path.
    expect(sql.calls[0]?.params[0]).toBe("C-1");
  });

  it("a gateway error is relayed whole, its pacing headers with it, and nothing is recorded", async () => {
    const { app, sql } = await appWith({
      "POST /proxy/my/contracts/C-1/accept": { status: 429, body: '{"error":{"message":"slow down"}}', headers: { "Retry-After": "7", "X-RateLimit-Remaining": "0", "Set-Cookie": "a=b" } },
    });
    const res = await post(app, "/api/agent/v1/contracts/C-1/accept");
    expect(res.status).toBe(429);
    expect(res.text).toBe("slow down\n");
    expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(res.headers["retry-after"]).toBe("7");
    expect(res.headers["x-ratelimit-remaining"]).toBe("0");
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(sql.calls).toEqual([]);
  });

  it("an answer that does not fit is a 502; a gateway that does not answer is a 504", async () => {
    const { app, sql } = await appWith({
      "POST /proxy/my/contracts/C-1/accept": ok('{"agent":{"credits":"x"}}'),
      "POST /proxy/my/contracts/C-1/fulfill": "hangup",
    });
    const bad = await post(app, "/api/agent/v1/contracts/C-1/accept");
    expect([bad.status, bad.headers["content-type"]]).toEqual([502, "text/plain; charset=utf-8"]);
    const gone = await post(app, "/api/agent/v1/contracts/C-1/fulfill");
    expect([gone.status, gone.text]).toEqual([504, "st-gateway did not answer\n"]);
    expect(sql.calls).toEqual([]);
  });

  it("history is best effort: a database that refuses the row is logged and the answer is still the gateway's", async () => {
    const { app, errors } = await appWith({ "POST /proxy/my/contracts/C-1/accept": ok(CONTRACT_AND_AGENT) }, new FakeSql().on(/INSERT/, new Error("Data too long for column 'id'")));
    const res = await post(app, "/api/agent/v1/contracts/C-1/accept");
    expect([res.status, res.text]).toEqual([200, `${CONTRACT_AND_AGENT}\n`]);
    expect(errors).toEqual(["failed to persist contract C-1: Data too long for column 'id'"]);
  });

  it("an empty 2xx answer is the zero result, and the zero contract is recorded", async () => {
    const { app, sql } = await appWith({ "POST /proxy/my/contracts/C-1/accept": { status: 204 } });
    const res = await post(app, "/api/agent/v1/contracts/C-1/accept");
    expect(res.status).toBe(200);
    expect((JSON.parse(res.text) as { contract: { id: string } }).contract.id).toBe("");
    expect(sql.calls[0]?.params.slice(0, 3)).toEqual(["", "", ""]);
  });
});

describe("POST /ships/purchase", () => {
  const route = "/api/agent/v1/ships/purchase";

  it("forwards only the two known members, answers the decoded result, records the purchase with the ship of the answer", async () => {
    const { app, seen, sql } = await appWith({ "POST /proxy/my/ships": ok(PURCHASE) });
    const res = await post(app, route, '{"SHIPTYPE":"SHIP_REQUESTED","waypointsymbol":"X1-REQUESTED","extra":{"a":1}} trailing');
    expect(res.status).toBe(200);
    expect((JSON.parse(res.text) as { ship: { symbol: string } }).ship.symbol).toBe("NEW-1");
    expect(res.text).toContain('"credits":9007199254740993');
    expect(seen[0]?.body).toBe('{"shipType":"SHIP_REQUESTED","waypointSymbol":"X1-REQUESTED"}');
    expect(seen[0]?.headers["content-type"]).toBe("application/json");
    expect(seen[0]?.headers.authorization).toBe(SESSION);
    expect(sql.calls[0]?.params).toEqual(["SHIP_PURCHASE", "NEW-1", "X1-C", "SHIP_PROBE", null, null, null, "55000", "9007199254740993", "2026-03-04 05:06:07"]);
  });

  it("a body error comes first, then a missing member, both before the gateway is asked", async () => {
    const { app, seen, sql } = await appWith({});
    const cut = await post(app, route, '{"shipType":');
    expect([cut.status, cut.text, cut.headers["content-type"]]).toEqual([400, "invalid request body: unexpected EOF\n", "text/plain; charset=utf-8"]);
    const missing = await post(app, route, '{"shipType":"A"}');
    expect([missing.status, missing.text]).toEqual([400, "shipType and waypointSymbol are required\n"]);
    for (const body of ["", "null", "{}", '{"shipType":"","waypointSymbol":"W"}', '{"shipType":null,"waypointSymbol":"W"}']) {
      expect((await post(app, route, body)).status).toBe(400);
    }
    expect(seen).toEqual([]);
    expect(sql.calls).toEqual([]);
  });

  it("a body tsoa would refuse (a missing member, other types) is the handler's business, never tsoa's", async () => {
    const { app } = await appWith({});
    // tsoa would say "'shipType' is required"; the handler says its own sentence.
    expect((await post(app, route, "{}")).text).toBe("shipType and waypointSymbol are required\n");
    expect((await post(app, route, '{"shipType":5,"waypointSymbol":"W"}')).text).toMatch(/^invalid request body: .+\n$/);
  });

  it("Content-Type is never checked", async () => {
    const { app } = await appWith({ "POST /proxy/my/ships": ok(PURCHASE) });
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "application/json; charset=latin1"]) {
      const res = await request(app).post(route).set("Authorization", SESSION).set("Content-Type", type).send('{"shipType":"A","waypointSymbol":"B"}');
      expect(res.status).toBe(200);
    }
    const none = await request(app).post(route).set("Authorization", SESSION).send(Buffer.from('{"shipType":"A","waypointSymbol":"B"}'));
    expect(none.status).toBe(200);
  });

  it("an empty 200 is the zero result and records a zero SHIP_PURCHASE row with no ship symbol", async () => {
    const { app, sql } = await appWith({ "POST /proxy/my/ships": { body: "" } });
    const res = await post(app, route, '{"shipType":"A","waypointSymbol":"B"}');
    expect(res.status).toBe(200);
    expect(sql.calls[0]?.params.slice(0, 9)).toEqual(["SHIP_PURCHASE", "", "", "", null, null, null, "0", "0"]);
  });

  it("a database that refuses the row is logged; the answer is whole", async () => {
    const { app, errors } = await appWith({ "POST /proxy/my/ships": ok(PURCHASE) }, new FakeSql().on(/INSERT/, new Error("nope")));
    const res = await post(app, route, '{"shipType":"A","waypointSymbol":"B"}');
    expect(res.status).toBe(200);
    expect(errors).toEqual(["failed to persist SHIP_PURCHASE transaction for NEW-1: nope"]);
  });
});

describe.each([
  ["purchase", "PURCHASE"],
  ["sell", "SELL"],
])("POST /ships/{symbol}/%s", (action, type) => {
  const route = `/api/agent/v1/ships/S-1/${action}`;
  const upstream = `POST /proxy/my/ships/S-1/${action}`;

  it("forwards the symbol and the units exactly, answers the result, records the trade: ship from the path, the rest from the answer", async () => {
    const { app, seen, sql } = await appWith({ [upstream]: ok(MARKET) });
    const res = await post(app, route, '{"symbol":"REQUESTED","units":9223372036854775807}');
    expect(res.status).toBe(200);
    expect(res.text).toBe(`${MARKET}\n`);
    expect(seen[0]?.body).toBe('{"symbol":"REQUESTED","units":9223372036854775807}');
    expect(seen[0]?.headers["content-type"]).toBe("application/json");
    expect(sql.calls[0]?.params).toEqual([type, "S-1", "X1-A", null, "IRON", "4", "25", "100", "9007199254740993", "2026-03-04 05:06:07"]);
  });

  it("the symbol is forwarded as sent, whatever JSON would escape in it", async () => {
    const { app, seen } = await appWith({ [upstream]: ok(MARKET) });
    const symbol = 'a"b\\c<d>&e é\u{1F600}';
    await post(app, route, JSON.stringify({ symbol, units: 1 }));
    expect((JSON.parse(seen[0]?.body ?? "") as { symbol: string }).symbol).toBe(symbol);
  });

  it.each([
    ["no body", ""],
    ["null", "null"],
    ["{}", "{}"],
    ["zero units", '{"symbol":"X","units":0}'],
    ["negative units", '{"symbol":"X","units":-1}'],
    ["units of -0", '{"symbol":"X","units":-0}'],
    ["the smallest 64-bit units", '{"symbol":"X","units":-9223372036854775808}'],
    ["an empty symbol", '{"symbol":"","units":1}'],
    ["a null symbol", '{"symbol":null,"units":1}'],
    ["no units", '{"symbol":"X"}'],
  ])("%s: 400 with the route's sentence (or the decoder's), the gateway is not asked", async (_name, body) => {
    const { app, seen, sql } = await appWith({ [upstream]: ok(MARKET) });
    const res = await post(app, route, body);
    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(res.text).toMatch(body === "" ? /^invalid request body: EOF\n$/ : /^symbol and units \(>0\) are required\n$/);
    expect(seen).toEqual([]);
    expect(sql.calls).toEqual([]);
  });

  it.each(["1.5", "2.0", "1e2", '"5"', "true", "[]", "9223372036854775808"])("units %s is not an integer: 400 invalid request body", async (units) => {
    const { app, seen } = await appWith({ [upstream]: ok(MARKET) });
    const res = await post(app, route, `{"symbol":"X","units":${units}}`);
    expect(res.status).toBe(400);
    expect(res.text).toMatch(/^invalid request body: .+\n$/);
    expect(seen).toEqual([]);
  });

  it("a body over 1 MiB is a 400, and so is garbage over 1 MiB; a 900 000 character string is read whole", async () => {
    const { app, seen } = await appWith({ [upstream]: ok(MARKET) });
    const big = await post(app, route, JSON.stringify({ symbol: "k".repeat((1 << 20) + 10), units: 1 }));
    expect([big.status, big.text]).toEqual([400, "invalid request body: http: request body too large\n"]);
    const garbage = await post(app, route, "x".repeat((1 << 20) + 10));
    expect(garbage.status).toBe(400);
    expect(garbage.text).toMatch(/^invalid request body: invalid character/);
    expect(seen).toEqual([]);
    const fits = await post(app, route, JSON.stringify({ symbol: "k".repeat(900_000), units: 1 }));
    expect(fits.status).toBe(200);
    expect((JSON.parse(seen[0]?.body ?? "") as { symbol: string }).symbol).toHaveLength(900_000);
  });

  it("the gateway's verdict is relayed, with its pacing headers, and nothing is recorded", async () => {
    const { app, sql } = await appWith({ [upstream]: { status: 400, body: '{"error":{"message":"not enough credits"}}', headers: { "X-RateLimit-Limit": "2" } } });
    const res = await post(app, route, '{"symbol":"X","units":1}');
    expect([res.status, res.text, res.headers["x-ratelimit-limit"]]).toEqual([400, "not enough credits\n", "2"]);
    expect(sql.calls).toEqual([]);
  });

  it("an empty 2xx records a zero row for the ship in the path, at the time of the request", async () => {
    const { app, sql } = await appWith({ [upstream]: { status: 204 } });
    const before = Date.now();
    const res = await post(app, route, '{"symbol":"X","units":1}');
    expect(res.status).toBe(200);
    expect(sql.calls[0]?.params.slice(0, 9)).toEqual([type, "S-1", "", null, "", "0", "0", "0", "0"]);
    const stamp = Date.parse(`${String(sql.calls[0]?.params[9]).replace(" ", "T")}Z`);
    expect(Math.abs(stamp - before)).toBeLessThan(60_000);
  });

  it("a ship symbol with bytes that are not UTF-8 is forwarded escaped, answered, and refused by the history like MySQL refuses it", async () => {
    const { app, seen, sql, errors } = await appWith({ [`POST /proxy/my/ships/%FF/${action}`]: ok(MARKET) });
    const res = await post(app, `/api/agent/v1/ships/%FF/${action}`, '{"symbol":"X","units":1}');
    expect(res.status).toBe(200);
    expect(seen[0]?.url).toBe(`/proxy/my/ships/%FF/${action}`);
    expect(sql.calls).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it("history is best effort", async () => {
    const { app, errors } = await appWith({ [upstream]: ok(MARKET) }, new FakeSql().on(/INSERT/, new Error("Out of range value for column 'units'")));
    const res = await post(app, route, '{"symbol":"X","units":1}');
    expect([res.status, res.text]).toEqual([200, `${MARKET}\n`]);
    expect(errors).toEqual([`failed to persist ${type} transaction for S-1: Out of range value for column 'units'`]);
  });
});

describe("POST /contracts/{id}/deliveries", () => {
  const route = "/api/agent/v1/contracts/C-1/deliveries";

  it("records the delivery and answers the row, with the time the handler read", async () => {
    const { app, sql, seen } = await appWith({});
    const before = Date.now();
    const res = await post(app, route, '{"shipSymbol":"SHIP-1","tradeSymbol":"IRON","units":5}');
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");
    const row = JSON.parse(res.text) as Record<string, unknown>;
    expect(Object.keys(row)).toEqual(["contractId", "shipSymbol", "tradeSymbol", "units", "deliveredAt"]);
    expect(row).toMatchObject({ contractId: "C-1", shipSymbol: "SHIP-1", tradeSymbol: "IRON", units: 5 });
    expect(String(row.deliveredAt)).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,9})?Z$/);
    expect(Math.abs(Date.parse(String(row.deliveredAt)) - before)).toBeLessThan(60_000);
    expect(seen).toEqual([]);
    expect(sql.calls).toHaveLength(1);
    expect(sql.calls[0]?.sql).toContain("INSERT INTO contract_deliveries");
    expect(sql.calls[0]?.params.slice(0, 4)).toEqual(["C-1", "SHIP-1", "IRON", "5"]);
    // The stored time is the answered one, to the microsecond at most.
    const answered = Date.parse(String(row.deliveredAt));
    expect(Math.abs(Date.parse(`${String(sql.calls[0]?.params[4]).replace(" ", "T")}Z`) - answered)).toBeLessThan(1);
  });

  it.each([
    ["no body", "", /^invalid request body: EOF\n$/],
    ["no shipSymbol", '{"tradeSymbol":"T","units":1}', /^shipSymbol, tradeSymbol and units \(>0\) are required\n$/],
    ["no tradeSymbol", '{"shipSymbol":"S","units":1}', /^shipSymbol, tradeSymbol and units \(>0\) are required\n$/],
    ["zero units", '{"shipSymbol":"S","tradeSymbol":"T","units":0}', /^shipSymbol, tradeSymbol and units \(>0\) are required\n$/],
    ["negative units", '{"shipSymbol":"S","tradeSymbol":"T","units":-3}', /^shipSymbol, tradeSymbol and units \(>0\) are required\n$/],
    ["units as a string", '{"shipSymbol":"S","tradeSymbol":"T","units":"3"}', /^invalid request body: .+\n$/],
  ])("%s: 400, nothing written", async (_n, body, text) => {
    const { app, sql } = await appWith({});
    const res = await post(app, route, body);
    expect(res.status).toBe(400);
    expect(res.text).toMatch(text);
    expect(sql.calls).toEqual([]);
  });

  it("units beyond INT go to MySQL as they are, and MySQL's refusal is a 500 `failed to record delivery: `", async () => {
    const { app, sql } = await appWith({}, new FakeSql().on(/INSERT/, new Error("Out of range value for column 'units' at row 1")));
    const res = await post(app, route, '{"shipSymbol":"S","tradeSymbol":"T","units":2147483648}');
    expect([res.status, res.text, res.headers["content-type"]]).toEqual([500, "failed to record delivery: Out of range value for column 'units' at row 1\n", "text/plain; charset=utf-8"]);
    expect(sql.calls[0]?.params[3]).toBe("2147483648");
  });

  it("a contract id that is not UTF-8 is a 500 like MySQL's", async () => {
    const { app, sql } = await appWith({});
    const res = await post(app, "/api/agent/v1/contracts/%FF/deliveries", '{"shipSymbol":"S","tradeSymbol":"T","units":1}');
    expect(res.status).toBe(500);
    expect(res.text).toMatch(/^failed to record delivery: /);
    expect(sql.calls).toEqual([]);
  });

  it("the id is the path's, decoded", async () => {
    const { app, sql } = await appWith({});
    await post(app, "/api/agent/v1/contracts/a%20b/deliveries", '{"shipSymbol":"S","tradeSymbol":"T","units":1}');
    expect(sql.calls[0]?.params[0]).toBe("a b");
  });
});

describe("redirects of a POST: what Go's client does", () => {
  it("a 302 turns it into a GET without a body that still carries Content-Type (and Authorization, same host)", async () => {
    const { app, seen } = await appWith({
      "POST /proxy/my/ships": { status: 302, headers: { Location: "/proxy/moved" } },
      "GET /proxy/moved": ok(PURCHASE),
    });
    const res = await post(app, "/api/agent/v1/ships/purchase", '{"shipType":"A","waypointSymbol":"B"}');
    expect(res.status).toBe(200);
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(["POST /proxy/my/ships", "GET /proxy/moved"]);
    expect(seen[1]?.body).toBe("");
    expect(seen[1]?.headers["content-type"]).toBe("application/json");
    expect(seen[1]?.headers.authorization).toBe(SESSION);
  });

  it.each([[301], [303]])("a %s does the same", async (status) => {
    const { app, seen } = await appWith({
      "POST /proxy/my/ships/S-1/sell": { status, headers: { Location: "/proxy/moved" } },
      "GET /proxy/moved": ok(MARKET),
    });
    expect((await post(app, "/api/agent/v1/ships/S-1/sell", '{"symbol":"X","units":1}')).status).toBe(200);
    expect(seen[1]?.method).toBe("GET");
    expect(seen[1]?.headers["content-type"]).toBe("application/json");
  });

  it("a redirect of accept, which sent no body, sends no Content-Type", async () => {
    const { app, seen } = await appWith({
      "POST /proxy/my/contracts/C-1/accept": { status: 302, headers: { Location: "/proxy/moved" } },
      "GET /proxy/moved": ok(CONTRACT_AND_AGENT),
    });
    expect((await post(app, "/api/agent/v1/contracts/C-1/accept")).status).toBe(200);
    expect(seen[1]?.method).toBe("GET");
    expect(seen[1]?.headers["content-type"]).toBeUndefined();
  });

  it.each([[307], [308]])("a %s keeps the method and the body", async (status) => {
    const { app, seen } = await appWith({
      "POST /proxy/my/ships/S-1/purchase": { status, headers: { Location: "/proxy/moved" } },
      "POST /proxy/moved": ok(MARKET),
    });
    expect((await post(app, "/api/agent/v1/ships/S-1/purchase", '{"symbol":"X","units":3}')).status).toBe(200);
    expect(seen[1]).toMatchObject({ method: "POST", body: '{"symbol":"X","units":3}' });
    expect(seen[1]?.headers["content-type"]).toBe("application/json");
  });
});

describe("GET /contracts/{id}/deliveries", () => {
  const route = "/api/agent/v1/contracts/C-1/deliveries";

  it("is public: a visitor is served, the centre is not asked, MySQL is asked for the contract", async () => {
    const sql = new FakeSql().on(/FROM contract_deliveries/, [["C-1", "S", "IRON", 5, "2026-03-04 05:06:07"]]);
    const { app, centre } = await appWith({}, sql, READER);
    const res = await request(app).get(route);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");
    expect(res.text).toBe('[{"contractId":"C-1","shipSymbol":"S","tradeSymbol":"IRON","units":5,"deliveredAt":"2026-03-04T05:06:07Z"}]\n');
    expect(centre.asked).toEqual([]);
    expect(sql.calls[0]?.params).toEqual(["C-1"]);
  });

  it("no deliveries is [], never null", async () => {
    const { app } = await appWith({});
    const res = await request(app).get(route);
    expect(res.text).toBe("[]\n");
  });

  it("a presented token is verified, and a scopeless session is served", async () => {
    const { app, centre } = await appWith({}, new FakeSql(), READER);
    expect((await request(app).get(route).set("Authorization", SESSION)).status).toBe(200);
    expect(centre.asked).toEqual(["a-session"]);
  });

  it("a malformed Authorization header is a visitor, still served", async () => {
    const { app, centre } = await appWith({});
    expect((await request(app).get(route).set("Authorization", "Basic Zm9v")).status).toBe(200);
    expect(centre.asked).toEqual([]);
  });

  it("HEAD is GET without the body", async () => {
    const { app } = await appWith({});
    const res = await request(app).head(route);
    expect([res.status, res.headers["content-type"]]).toEqual([200, "application/json"]);
  });

  it("a database error is a 500 `failed to load deliveries: `", async () => {
    const { app } = await appWith({}, new FakeSql().on(/SELECT/, new Error("gone away")));
    const res = await request(app).get(route);
    expect([res.status, res.text, res.headers["content-type"]]).toEqual([500, "failed to load deliveries: gone away\n", "text/plain; charset=utf-8"]);
  });

  it("the id is matched in SQL, as the router decoded it; bytes that are not UTF-8 are passed as bytes", async () => {
    const sql = new FakeSql();
    const { app } = await appWith({}, sql);
    await request(app).get("/api/agent/v1/contracts/a%20b/deliveries");
    await request(app).get("/api/agent/v1/contracts/%FF/deliveries");
    expect(sql.calls[0]?.params).toEqual(["a b"]);
    expect(sql.calls[1]?.params).toEqual([Buffer.from([0xff])]);
  });
});

describe("GET /transactions", () => {
  const route = "/api/agent/v1/transactions";
  const LIMIT = "limit must be a positive integer\n";
  const TYPE = "type must be one of: SHIP_PURCHASE, PURCHASE, SELL\n";
  const listing = async (query: string, identity = READER as typeof READER | typeof WRITER) => {
    const sql = new FakeSql();
    const { app, centre } = await appWith({}, sql, identity);
    const res = await request(app).get(`${route}${query}`);
    return { res, sql, centre };
  };

  it("is public, newest first, default limit 100, and answers rows as the API shows them", async () => {
    const sql = new FakeSql().on(/FROM transactions/, [
      ["SELL", "S", "W", null, "T", 4, 25, "9007199254740995", "9007199254740993", "2026-03-04 05:06:07"],
      ["SHIP_PURCHASE", "S2", "W2", "SHIP_PROBE", null, null, null, "55000", "120000", "2026-03-04 05:06:06"],
    ]);
    const { app, centre } = await appWith({}, sql, READER);
    const res = await request(app).get(route);
    expect(res.status).toBe(200);
    expect(res.text).toBe(
      '[{"type":"SELL","shipSymbol":"S","waypointSymbol":"W","tradeSymbol":"T","units":4,"pricePerUnit":25,"totalPrice":9007199254740995,"agentCredits":9007199254740993,"occurredAt":"2026-03-04T05:06:07Z"},' +
        '{"type":"SHIP_PURCHASE","shipSymbol":"S2","waypointSymbol":"W2","shipType":"SHIP_PROBE","totalPrice":55000,"agentCredits":120000,"occurredAt":"2026-03-04T05:06:06Z"}]\n',
    );
    expect(centre.asked).toEqual([]);
    expect(sql.calls[0]?.sql.replace(/\s+/g, " ")).toContain("FROM transactions ORDER BY occurred_at DESC LIMIT ?");
    expect(sql.calls[0]?.params).toEqual(["100"]);
  });

  it("an empty history is [], never null", async () => {
    const { res } = await listing("");
    expect(res.text).toBe("[]\n");
  });

  it("filters by ship and type in SQL, and passes the limit", async () => {
    const { sql } = await listing("?shipSymbol=SHIP-1&type=SELL&limit=7");
    expect(sql.calls[0]?.sql.replace(/\s+/g, " ")).toContain("WHERE ship_symbol = ? AND type = ? ORDER BY occurred_at DESC LIMIT ?");
    expect(sql.calls[0]?.params).toEqual(["SHIP-1", "SELL", "7"]);
  });

  it.each([
    ["limit=02", "2"],
    ["limit=%2B3", "3"],
    ["limit=000000000000000000000004", "4"],
    ["limit=1000", "1000"],
    ["limit=1001", "1000"],
    ["limit=99999999999", "1000"],
    ["limit=9223372036854775807", "1000"],
    ["limit=", "100"],
    ["limit=2&limit=abc", "2"],
    ["limit=&limit=5", "100"],
    ["Limit=1&other=1", "100"],
    ["limit=2;x=1", "100"],
    ["limit=%zz", "100"],
    ["x=1&limit=3", "3"],
  ])("%s: limit %s", async (query, limit) => {
    const { res, sql } = await listing(`?${query}`);
    expect(res.status).toBe(200);
    expect(sql.calls[0]?.params.at(-1)).toBe(limit);
  });

  it.each(["0", "-1", "-0", "abc", "1.5", "1e3", "%205", "5%20", "0x10", "99999999999999999999", "9223372036854775808", "+", "-", "%2B%2B5", "%D9%A1%D9%A2", "1_000", "1,000", "NaN", "null"])(
    "limit=%s: 400 `limit must be a positive integer`, MySQL is not asked, no session needed",
    async (limit) => {
      const { res, sql, centre } = await listing(`?limit=${limit}`);
      expect([res.status, res.text, res.headers["content-type"]]).toEqual([400, LIMIT, "text/plain; charset=utf-8"]);
      expect(sql.calls).toEqual([]);
      expect(centre.asked).toEqual([]);
    },
  );

  it.each(["purchase", "Purchase", "sell", "FOO", "%20PURCHASE", "PURCHASE%20", "SHIP_PURCHASE,SELL", "PURCHASE%00", "SHIP-PURCHASE", "0", "undefined"])(
    "type=%s: 400 `type must be one of: ...`",
    async (type) => {
      const { res, sql } = await listing(`?type=${type}`);
      expect([res.status, res.text]).toEqual([400, TYPE]);
      expect(sql.calls).toEqual([]);
    },
  );

  it("a bad type is reported before a bad limit, whatever the order in the URL", async () => {
    expect((await listing("?limit=abc&type=nope")).res.text).toBe(TYPE);
    expect((await listing("?type=nope&limit=abc")).res.text).toBe(TYPE);
    expect((await listing("?type=SELL&limit=0")).res.text).toBe(LIMIT);
  });

  it("empty type and shipSymbol are no filter; the first of a repeated name wins; names are case sensitive; unknown ones are ignored", async () => {
    const a = await listing("?shipSymbol=&type=&limit=");
    expect(a.sql.calls[0]?.params).toEqual(["100"]);
    const b = await listing("?type=SELL&type=bogus&shipSymbol=A&shipSymbol=B");
    expect(b.sql.calls[0]?.params).toEqual(["A", "SELL", "100"]);
    const c = await listing("?TYPE=SELL&shipsymbol=X&other=1");
    expect(c.sql.calls[0]?.params).toEqual(["100"]);
  });

  it("parameters are percent-decoded and a plus is a space; a pair with a bad escape or a semicolon is dropped", async () => {
    const a = await listing("?shipSymbol=a+b%20c&type=%53ELL");
    expect(a.sql.calls[0]?.params).toEqual(["a b c", "SELL", "100"]);
    const b = await listing("?shipSymbol=A&type=%zz");
    expect(b.sql.calls[0]?.params).toEqual(["A", "100"]);
    const c = await listing("?shipSymbol=A;type=SELL");
    expect(c.sql.calls[0]?.params).toEqual(["100"]);
  });

  it("a presented token is verified like on the other public read; a visitor is not asked", async () => {
    const { res, centre } = await listing("", WRITER);
    expect(res.status).toBe(200);
    expect(centre.asked).toEqual([]);
    const sql = new FakeSql();
    const { app, centre: c2 } = await appWith({}, sql, READER);
    expect((await request(app).get(route).set("Authorization", SESSION)).status).toBe(200);
    expect(c2.asked).toEqual(["a-session"]);
  });

  it("a database error is a 500 `failed to load transactions: `", async () => {
    const { app } = await appWith({}, new FakeSql().on(/SELECT/, new Error("gone away")));
    const res = await request(app).get(route);
    expect([res.status, res.text]).toEqual([500, "failed to load transactions: gone away\n"]);
  });

  it("HEAD is GET without the body, and still asks the database", async () => {
    const sql = new FakeSql();
    const { app } = await appWith({}, sql);
    const res = await request(app).head(route);
    expect([res.status, res.headers["content-type"]]).toEqual([200, "application/json"]);
    expect(sql.calls).toHaveLength(1);
  });

  it("a ship symbol that is not UTF-8 is passed to MySQL as bytes", async () => {
    const { sql } = await listing("?shipSymbol=%FF");
    expect(sql.calls[0]?.params[0]).toEqual(Buffer.from([0xff]));
  });
});

describe("Swagger UI", () => {
  const DOCS = "/api/agent/swagger/";

  it("serves an HTML page at the slash path, without asking the centre or reading credentials", async () => {
    const { app, centre } = createTestApp();
    for (const auth of [undefined, "Bearer x", "garbage", "Bearer"]) {
      const r = request(app).get(DOCS);
      const res = await (auth === undefined ? r : r.set("Authorization", auth));
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/^text\/html/);
      expect(res.text).toContain("swagger-ui-init.js");
    }
    expect(centre.asked).toEqual([]);
  });

  it("the page's script carries the committed spec", async () => {
    const { app } = createTestApp();
    const res = await request(app).get(`${DOCS}swagger-ui-init.js`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/javascript/);
    expect(res.text).toContain('"/api/agent/v1/transactions"');
    expect(res.text).toContain('"/api/agent/v1/ships/{shipSymbol}/sell"');
    expect(res.text).toContain("Agent Info Service API");
  });

  it("serves its own files, and the page also at index.html; HEAD works", async () => {
    const { app } = createTestApp();
    expect((await request(app).get(`${DOCS}index.html`)).status).toBe(200);
    const css = await request(app).get(`${DOCS}swagger-ui.css`);
    expect([css.status, css.headers["content-type"]]).toEqual([200, expect.stringMatching(/^text\/css/)]);
    expect((await request(app).head(DOCS)).status).toBe(200);
  });

  it("the bare prefix, a file that is not there, and any other method are `404 page not found`, with no CORS headers", async () => {
    const { app } = createTestApp();
    for (const [method, path] of [
      ["get", "/api/agent/swagger"],
      ["head", "/api/agent/swagger"],
      ["get", `${DOCS}nope.txt`],
      ["post", DOCS],
      ["put", DOCS],
      ["delete", DOCS],
      ["patch", DOCS],
      ["post", "/api/agent/swagger"],
      ["delete", "/api/agent/swagger"],
      ["get", "/api/agent/Swagger/"],
    ] as const) {
      const res = await request(app)[method](path);
      expect([method, path, res.status]).toEqual([method, path, 404]);
      if (method !== "head") expect(res.text).toBe("404 page not found\n");
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    }
  });

  it("a preflight is answered like everywhere else", async () => {
    const { app } = createTestApp();
    expect((await request(app).options(DOCS)).status).toBe(204);
  });

  it("is our page at both names, with our script, never swagger-ui-dist's demo", async () => {
    const { app } = createTestApp();
    for (const p of [DOCS, `${DOCS}index.html`]) {
      const page = await request(app).get(p);
      expect(page.status).toBe(200);
      expect(page.text).toContain("swagger-ui-init.js");
      expect(page.text).not.toMatch(/petstore/i);
      expect(page.text).not.toContain("swagger-initializer.js");
    }
    const init = await request(app).get(`${DOCS}swagger-ui-init.js`);
    expect(init.text).not.toMatch(/petstore/i);
    expect(init.text).toContain("/api/agent/v1/transactions");
  });

  it("serves the files the page references, and no other file of swagger-ui-dist", async () => {
    const { app } = createTestApp();
    for (const file of ["swagger-ui.css", "swagger-ui-bundle.js", "swagger-ui-standalone-preset.js", "favicon-16x16.png", "favicon-32x32.png", "swagger-ui-init.js"]) {
      expect([file, (await request(app).get(`${DOCS}${file}`)).status]).toEqual([file, 200]);
    }
    const dist = path.dirname(require.resolve("swagger-ui-dist/package.json"));
    const others = fs.readdirSync(dist).filter((f) => !ASSETS.has(`/${f}`) && f !== "index.html");
    expect(others).toEqual(expect.arrayContaining(["README.md", "LICENSE", "index.js", "absolute-path.js", "swagger-initializer.js", "package.json"]));
    for (const file of [...others, "index.css", "oauth2-redirect.html", "swagger-ui.js"]) {
      const res = await request(app).get(`${DOCS}${file}`);
      expect([file, res.status, res.text]).toEqual([file, 404, "404 page not found\n"]);
    }
  });

  it("answers the assets from memory: the bytes of the dist file, with their type and length, and no file is opened per request", async () => {
    const { app } = createTestApp();
    const dist = path.dirname(require.resolve("swagger-ui-dist/package.json"));
    const open = jest.spyOn(fs, "createReadStream");
    const openFile = jest.spyOn(fs, "open");
    for (const [file, type] of [["swagger-ui.css", /^text\/css/], ["swagger-ui-bundle.js", /javascript/], ["favicon-16x16.png", /^image\/png/]] as const) {
      const res = await request(app).get(`${DOCS}${file}`).buffer(true).parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => { cb(null, Buffer.concat(chunks)); });
      });
      expect(res.headers["content-type"]).toMatch(type);
      expect(Number(res.headers["content-length"])).toBe(fs.statSync(path.join(dist, file)).size);
      expect((res.body as Buffer).equals(fs.readFileSync(path.join(dist, file)))).toBe(true);
      expect(res.headers["cache-control"]).toBe("public, max-age=0");
    }
    const head = await request(app).head(`${DOCS}swagger-ui.css`);
    expect([head.status, head.text || ""]).toEqual([200, ""]);
    expect(open).not.toHaveBeenCalled();
    expect(openFile).not.toHaveBeenCalled();
    open.mockRestore();
    openFile.mockRestore();
  });

  it("does not serve package.json", async () => {
    const { app } = createTestApp();
    expect((await request(app).get(`${DOCS}package.json`)).status).toBe(404);
  });
});
