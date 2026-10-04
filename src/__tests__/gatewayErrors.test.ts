/**
 * @file The shared upstream-error contract (meta/fixtures/gateway-errors.json),
 * driven through the TypeScript mapping.
 *
 * The fixture is read from the contract suite's pinned copy (contract/fixtures,
 * sha256 in SOURCE.txt, verified by the suite itself): one copy in the
 * repository, not two. Each case runs a real HTTP stub gateway, `callGateway`
 * against it, and `writeUpstreamError` into a real Express response, so what is
 * asserted is what a caller receives: status, sentence, pacing headers.
 * An assertion key this test cannot check fails the case instead of being
 * skipped, so a fixture that grows a key cannot quietly become a status-only test.
 */

import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import express from "express";
import request from "supertest";
import { GatewayClient } from "../gateway/client";
import {
  gatewayDidNotAnswer,
  NO_ANSWER,
  pacingHeaders,
  UnreadableAnswer,
  upstreamMessage,
  writeUpstreamError,
} from "../gateway/errors";

interface Case {
  name: string;
  gateway: { transport?: string; status?: number; body?: string; headers?: Record<string, string>; bodyRepeat?: { chunk: string; times: number } };
  expect: { status?: number; message?: string; messageContains?: string; messageNotEmpty?: boolean; messageMaxLength?: number; headers?: Record<string, string> };
}

const KNOWN = new Set(["status", "message", "messageContains", "messageNotEmpty", "messageMaxLength", "headers"]);
const fixture = path.join(__dirname, "..", "..", "contract", "fixtures", "gateway-errors.json");
const cases = (JSON.parse(fs.readFileSync(fixture, "utf8")) as { cases: Case[] }).cases;

const servers: http.Server[] = [];
afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
});

async function stub(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** The smallest route that does what a route PR's handler will: call the gateway, relay the verdict. */
function appFor(url: string) {
  const app = express();
  app.get("/probe", async (_req, res) => {
    try {
      res.status(200).json(await new GatewayClient(`${url}/proxy`).getMyAgent({ authorization: "Bearer t" }).then(() => ({})));
    } catch (err) {
      writeUpstreamError(res, err, () => undefined);
    }
  });
  return app;
}

describe("the shared upstream-error contract", () => {
  it("drives the whole contract, not a subset of it", () => {
    expect(cases.length).toBeGreaterThanOrEqual(10);
  });

  it.each(cases.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    expect(Object.keys(c.expect).filter((k) => !KNOWN.has(k))).toEqual([]);
    expect(c.expect.status).toBeDefined();

    let url: string;
    if (c.gateway.transport === "no-response") {
      // A server that is already gone: connection refused.
      const dead = await stub(() => undefined);
      const server = servers.pop() as http.Server;
      await new Promise((r) => server.close(r));
      url = dead;
    } else {
      expect(c.gateway.transport).toBeUndefined();
      const body = c.gateway.bodyRepeat ? c.gateway.bodyRepeat.chunk.repeat(c.gateway.bodyRepeat.times) : (c.gateway.body ?? "");
      url = await stub((_req, res) => {
        for (const [k, v] of Object.entries(c.gateway.headers ?? {})) res.setHeader(k, v);
        res.setHeader("Content-Type", "application/json");
        res.statusCode = c.gateway.status ?? 200;
        res.end(body);
      });
    }

    const res = await request(appFor(url)).get("/probe");
    expect(res.status).toBe(c.expect.status);
    const message = res.text.replace(/\n+$/, "");
    if (c.expect.message !== undefined) expect(message).toBe(c.expect.message);
    if (c.expect.messageContains !== undefined) expect(message).toContain(c.expect.messageContains);
    if (c.expect.messageNotEmpty === true) expect(message.trim()).not.toBe("");
    if (c.expect.messageMaxLength !== undefined) expect([...message].length).toBeLessThanOrEqual(c.expect.messageMaxLength);
    for (const [name, value] of Object.entries(c.expect.headers ?? {})) expect(res.headers[name.toLowerCase()]).toBe(value);
    expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
  });
});

describe("what the fixture leaves open (contract/suites/upstream-errors.ts pins it end to end)", () => {
  it("lifts error.message exactly as the Go decoder does", () => {
    const m = (body: string) => upstreamMessage(body);
    expect(m('{"error":{"message":"m","code":4214},"other":2}')).toBe("m");
    expect(m('{"error":{"message":"  m  "}}')).toBe("  m  ");
    expect(m('{"error":{"message":"first","message":"last"}}')).toBe("last");
    expect(m('{"ERROR":{"Message":"shouting"}}')).toBe("shouting");
    for (const raw of ['{"error":{"message":"   "}}', '{"error":{"message":""}}', '{"error":"text"}', '{"error":{"message":5}}', '{"error":null}', '{"message":"top"}', '[{"error":{"message":"x"}}]', "plain text"]) {
      expect(m(raw)).toBe(raw);
    }
    // A wrongly typed member fails the whole decode in Go, whichever spelling or order: raw body.
    for (const raw of ['{"error":{"message":5,"MESSAGE":"x"}}', '{"error":{"MESSAGE":"x","message":5}}', '{"error":{"message":"x"},"Error":"text"}']) {
      expect(m(raw)).toBe(raw);
    }
    expect(m("   \n")).toBe("st-gateway returned an error with no message");
    expect(m("")).toBe("st-gateway returned an error with no message");
  });

  it("cuts a raw body at 500 characters, not bytes, and never cuts an envelope's message", () => {
    expect(upstreamMessage("x".repeat(600))).toBe("x".repeat(500));
    expect(upstreamMessage("\u{1F600}".repeat(600))).toBe("\u{1F600}".repeat(500));
    const long = "m".repeat(5000);
    expect(upstreamMessage(JSON.stringify({ error: { message: long } }))).toBe(long);
  });

  it("relays only the non-empty pacing headers, on any error status", async () => {
    expect(pacingHeaders(new Headers({ "retry-after": "9", "x-ratelimit-limit": "", "set-cookie": "a=b", "x-request-id": "1" }))).toEqual({ "Retry-After": "9" });
    const url = await stub((_req, res) => {
      res.statusCode = 500;
      res.setHeader("Retry-After", "5");
      res.setHeader("X-Request-Id", "abc");
      res.end('{"error":{"message":"x"}}');
    });
    const res = await request(appFor(url)).get("/probe");
    expect(res.status).toBe(500);
    expect(res.headers["retry-after"]).toBe("5");
    expect(res.headers["x-request-id"]).toBeUndefined();
  });

  it("a status outside 400-599 is a 502 with the gateway's sentence", async () => {
    const url = await stub((_req, res) => {
      res.statusCode = 600;
      res.end('{"error":{"message":"gateway says 600"}}');
    });
    const res = await request(appFor(url)).get("/probe");
    expect([res.status, res.text]).toEqual([502, "gateway says 600\n"]);
  });

  it("a 2xx body that dies half way is 'did not answer', and never names the address", async () => {
    const url = await stub((req) => {
      req.socket.write("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{\"data\":");
      req.socket.destroy();
    });
    const res = await request(appFor(url)).get("/probe");
    expect([res.status, res.text]).toEqual([504, `${NO_ANSWER}\n`]);
    expect(res.text).not.toContain("127.0.0.1");
  });

  it("an empty 2xx body is not an error; a 2xx that is not JSON is a 502", async () => {
    const ok = await stub((_req, res) => {
      res.statusCode = 204;
      res.end();
    });
    await expect(new GatewayClient(`${ok}/proxy`).getMyAgent({ authorization: "" })).resolves.toMatchObject({ symbol: "" });
    const bad = await stub((_req, res) => res.end("   "));
    await expect(new GatewayClient(`${bad}/proxy`).getMyAgent({ authorization: "" })).rejects.toBeInstanceOf(UnreadableAnswer);
  });

  it("forwards the caller's Authorization byte for byte, and nothing else of the caller", async () => {
    const seen: http.IncomingHttpHeaders[] = [];
    const url = await stub((req, res) => {
      seen.push(req.headers);
      res.end("{}");
    });
    const client = new GatewayClient(`${url}/proxy`);
    await client.getMyAgent({ authorization: "Bearer   tok" });
    await client.getMyAgent({ authorization: "" });
    expect(seen[0]?.["authorization"]).toBe("Bearer   tok");
    expect(seen[1]?.["authorization"]).toBeUndefined();
  });

  it("reads at most 64 KiB of an error body: an envelope cut in half is raw text", async () => {
    const body = `{"error":{"message":"${"y".repeat(100_000)}"}}`;
    const url = await stub((_req, res) => {
      res.statusCode = 500;
      res.end(body);
    });
    const res = await request(appFor(url)).get("/probe");
    expect([res.status, res.text]).toEqual([500, body.slice(0, 500) + "\n"]);
    const plain = await stub((_req, res) => {
      res.statusCode = 500;
      res.end("z".repeat(200_000));
    });
    expect((await request(appFor(plain)).get("/probe")).text).toBe("z".repeat(500) + "\n");
  });

  it("an error body that is cut short is used as far as it came", async () => {
    const url = await stub((req) => {
      req.socket.write('HTTP/1.1 500 Internal Server Error\r\nContent-Length: 100\r\n\r\n{"data":');
      req.socket.destroy();
    });
    const res = await request(appFor(url)).get("/probe");
    expect([res.status, res.text]).toEqual([500, '{"data":\n']);
  });

  it("the transport error stays in the chain for logs but not in the message", () => {
    const err = gatewayDidNotAnswer("GET", "/my/agent", new Error("connect ECONNREFUSED 10.0.0.7:3002"));
    expect(err.message).toBe(NO_ANSWER);
    expect(String((err.cause as Error).message)).toContain("10.0.0.7");
  });
});

describe("a raw body that is not UTF-8 goes out as it came, like Go's string(body)", () => {
  it("keeps the bytes of a short one, counts each bad byte as one rune, and writes U+FFFD once it cuts", async () => {
    const { upstreamMessageOf } = await import("../gateway/errors");
    const short = Buffer.from([0x61, 0xff, 0xe2, 0x82, 0x62]);
    expect(upstreamMessageOf(short)).toEqual({ message: "a���b", raw: short });
    // 250 truncated three-byte sequences are 500 runes in Go (two bad bytes each) and 250 in a decoder that merges them.
    expect(upstreamMessageOf(Buffer.alloc(500, 0xff)).raw).toBeDefined();
    const cut = upstreamMessageOf(Buffer.concat([Buffer.alloc(300, 0xff), Buffer.alloc(300, 0x41)]));
    expect(cut.raw).toBeUndefined();
    expect(cut.message).toBe("�".repeat(300) + "A".repeat(200));
    expect(upstreamMessageOf(Buffer.from([0xe2, 0x82]).toString("latin1").repeat(0) + "ok").raw).toBeUndefined();
  });

  it("is relayed byte for byte, with the newline", async () => {
    const url = await stub((_req, res) => {
      res.statusCode = 502;
      res.end(Buffer.from([0x62, 0x61, 0x64, 0xff, 0xfe]));
    });
    const res = await request(appFor(url)).get("/probe").buffer(true).parse((r, cb) => {
      const parts: Buffer[] = [];
      r.on("data", (c: Buffer) => parts.push(c));
      r.on("end", () => cb(null, Buffer.concat(parts)));
    });
    expect(Buffer.from(res.body as Buffer).equals(Buffer.from([0x62, 0x61, 0x64, 0xff, 0xfe, 0x0a]))).toBe(true);
  });

  it("trims with Go's TrimSpace: U+FEFF is not a space, U+0085 and U+3000 are", async () => {
    const { upstreamMessage } = await import("../gateway/errors");
    expect(upstreamMessage('{"error":{"message":"﻿"}}')).toBe("﻿");
    expect(upstreamMessage('{"error":{"message":"\u0085　"}}')).toBe('{"error":{"message":"\u0085　"}}');
    expect(upstreamMessage("\u0085 　")).toBe("st-gateway returned an error with no message");
    expect(upstreamMessage("﻿")).toBe("﻿");
  });
});
