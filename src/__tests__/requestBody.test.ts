import http from "node:http";
import type { AddressInfo } from "node:net";
import { DecodeError, decodeFirstValue } from "../gateway/decode";
import { JsonSyntaxError, parseFirstJson, parseJson } from "../gateway/json";
import { cargoTransactionRequestSchema, deliveryRequestSchema, purchaseShipRequestSchema } from "../gateway/schema";
import { decodeBody, MAX_BODY_BYTES, readBody, TOO_LARGE } from "../http/body";
import { TextAnswer } from "../http/json";
import { atoi, Query, rawQueryOf } from "../http/query";
import { CallerGone } from "../gateway/client";

const bytes = (s: string): Buffer => Buffer.from(s, "utf8");
const cargo = (s: string) => decodeFirstValue(cargoTransactionRequestSchema, bytes(s));
const message = (f: () => unknown): string => {
  try {
    f();
  } catch (err) {
    if (err instanceof DecodeError) return err.message;
    throw err;
  }
  throw new Error("did not throw");
};

describe("a request body is read like json.Decoder.Decode (contract README note 28)", () => {
  it("reads the first value and never looks at the rest", () => {
    expect(cargo('{"symbol":"X","units":3}')).toEqual({ symbol: "X", units: 3n });
    expect(cargo('{"symbol":"X","units":3} and then some text')).toEqual({ symbol: "X", units: 3n });
    expect(cargo('{"symbol":"X","units":3}{"units":-5}')).toEqual({ symbol: "X", units: 3n });
    expect(cargo('{"symbol":"X","units":3} [1,2')).toEqual({ symbol: "X", units: 3n });
    expect(cargo('{"symbol":"X","units":3}\u0000\u00ff garbage')).toEqual({ symbol: "X", units: 3n });
    expect(cargo('  \n\t{"symbol":"X","units":3}  ')).toEqual({ symbol: "X", units: 3n });
  });

  it("the value itself is checked whole before anything is bound", () => {
    expect(message(() => cargo('{"symbol":"X","units":3,}'))).toMatch(/invalid character/);
    expect(message(() => cargo('{"symbol":"X" "units":3}'))).toMatch(/invalid character/);
    expect(message(() => cargo('{"symbol":"\\x"}'))).toMatch(/invalid character/);
    expect(message(() => cargo("{'symbol':1}"))).toMatch(/invalid character/);
    expect(message(() => cargo('{"symbol":"x\ny"}'))).toMatch(/invalid character/);
    expect(message(() => cargo("﻿{}"))).toMatch(/invalid character/);
    expect(message(() => cargo('{"units":01}'))).toMatch(/invalid character/);
    expect(message(() => cargo('{"units":+1}'))).toMatch(/invalid character/);
    expect(message(() => cargo("{/*x*/}"))).toMatch(/invalid character/);
  });

  it("nothing at all, or only whitespace, is EOF; a value cut short is unexpected EOF", () => {
    expect(message(() => cargo(""))).toBe("EOF");
    expect(message(() => cargo("  \n\t\r "))).toBe("EOF");
    for (const cut of ["{", '{"units":', '{"units', "nul", '{"symbol":"X"', "[", '"abc', "tru", "-", "1.", "1e"]) {
      expect(message(() => cargo(cut))).toBe("unexpected EOF");
    }
  });

  it("a top-level literal ends where the literal ends", () => {
    // Go: "nullx" is null followed by something that is never read; a number stops at its first non-number byte.
    expect(cargo("nullx")).toEqual({ symbol: "", units: 0n });
    expect(message(() => cargo("0123"))).toMatch(/cannot unmarshal number/);
    expect(message(() => cargo("5abc"))).toMatch(/cannot unmarshal number/);
  });

  it("member names match in any case, with Go's folding, but not with other punctuation", () => {
    expect(cargo('{"SYMBOL":"A","UNITS":2}')).toEqual({ symbol: "A", units: 2n });
    expect(cargo('{"Symbol":"A","Units":2}')).toEqual({ symbol: "A", units: 2n });
    expect(cargo('{"symbol":"A","units":2,"unknown":{"a":[1,{"b":null}],"c":"d"},"other":1.5}')).toEqual({ symbol: "A", units: 2n });
    expect(cargo('{"s_ymbol":"A","units":2}')).toEqual({ symbol: "", units: 2n });
    expect(cargo('{"ſymbol":"A","unıts":2}').symbol).toBe("A"); // U+017F folds to s; dotless i does not fold to i
    expect(cargo('{"ſymbol":"A","unıts":2}').units).toBe(0n);
  });

  it("the last of a repeated member wins, whatever case it is written in", () => {
    expect(cargo('{"symbol":"A","units":2,"symbol":"B"}')).toEqual({ symbol: "B", units: 2n });
    expect(cargo('{"symbol":"A","SYMBOL":"B","Symbol":"C","units":1}').symbol).toBe("C");
    expect(cargo('{"symbol":"A","symbol":"","units":1}').symbol).toBe("");
  });

  it("null changes nothing: absent, and an earlier value survives it", () => {
    expect(cargo("null")).toEqual({ symbol: "", units: 0n });
    expect(cargo('{"symbol":null,"units":null}')).toEqual({ symbol: "", units: 0n });
    expect(cargo('{"symbol":"A","units":4,"symbol":null,"units":null}')).toEqual({ symbol: "A", units: 4n });
  });

  it("integers are 64-bit and exact; a fraction, an exponent, a string, or more than 64 bits is not an integer", () => {
    expect(cargo('{"units":9223372036854775807}').units).toBe(9223372036854775807n);
    expect(cargo('{"units":-9223372036854775808}').units).toBe(-9223372036854775808n);
    expect(cargo('{"units":9007199254740993}').units).toBe(9007199254740993n);
    expect(cargo('{"units":-0}').units).toBe(0n);
    for (const bad of ["1.5", "2.0", "1e2", "1E2", '"5"', "true", "{}", "[]", "9223372036854775808", "-9223372036854775809", "1e400"]) {
      expect(message(() => cargo(`{"units":${bad}}`))).toMatch(/cannot unmarshal/);
    }
  });

  it("a member of the wrong type is an error", () => {
    for (const bad of ["5", "true", "{}", "[]"]) expect(message(() => cargo(`{"symbol":${bad}}`))).toMatch(/cannot unmarshal/);
    for (const top of ["[]", '"x"', "5", "true"]) expect(message(() => cargo(top))).toMatch(/cannot unmarshal/);
  });

  it("strings are Go's: escapes, surrogate pairs, a lone surrogate or a bad byte is U+FFFD, whitespace is a value", () => {
    expect(cargo('{"symbol":"\\u0041\\u00e9\\ud83d\\ude00"}').symbol).toBe("Aé😀");
    expect(cargo('{"symbol":"\\ud83d"}').symbol).toBe("�");
    expect(decodeFirstValue(cargoTransactionRequestSchema, Buffer.from([0x7b, 0x22, 0x73, 0x79, 0x6d, 0x62, 0x6f, 0x6c, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])).symbol).toBe("�");
    expect(cargo('{"symbol":"\\u0000"}').symbol).toBe("\u0000");
    expect(decodeFirstValue(purchaseShipRequestSchema, bytes('{"shipType":" ","waypointSymbol":"\\t"}'))).toEqual({ shipType: " ", waypointSymbol: "\t" });
  });

  it("the other two request shapes bind their own members", () => {
    expect(decodeFirstValue(purchaseShipRequestSchema, bytes('{"waypointSymbol":"W","shipType":"T","extra":1}'))).toEqual({ shipType: "T", waypointSymbol: "W" });
    expect(decodeFirstValue(deliveryRequestSchema, bytes('{"shipSymbol":"S","tradeSymbol":"T","units":5}'))).toEqual({ shipSymbol: "S", tradeSymbol: "T", units: 5n });
  });

  it("parseFirstJson stops at the first value; parseJson still refuses anything after it", () => {
    expect(parseFirstJson(bytes("[1] x")).t).toBe("arr");
    expect(() => parseJson(bytes("[1] x"))).toThrow(JsonSyntaxError);
    expect(() => parseFirstJson(bytes("[1"))).toThrow(JsonSyntaxError);
  });

  it("a syntax error knows whether the input ended", () => {
    for (const [text, eof] of [["{", true], ["", true], ["{x", false], ["nul", true], ["nulx", false]] as const) {
      try {
        parseFirstJson(bytes(text));
        throw new Error("did not throw");
      } catch (err) {
        expect([text, (err as JsonSyntaxError).eof]).toEqual([text, eof]);
      }
    }
  });
});

describe("readBody", () => {
  /** A server that reads the body the way the routes do, and tells what it saw. */
  async function serve(limit: number | undefined, handler: (body: { bytes: Buffer; exceeded: boolean } | Error, res: http.ServerResponse) => void) {
    const server = http.createServer((req, res) => {
      (limit === undefined ? readBody(req) : readBody(req, limit)).then(
        (body) => { handler(body, res); },
        (err: unknown) => { handler(err as Error, res); },
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return {
      port: (server.address() as AddressInfo).port,
      close: () => new Promise((r) => server.close(r)),
    };
  }
  const post = (port: number, body: string | Buffer, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = http.request({ port, host: "127.0.0.1", method: "POST", headers }, (res) => {
        let text = "";
        res.on("data", (d) => { text += String(d); });
        res.on("end", () => { resolve({ status: res.statusCode ?? 0, text }); });
      });
      req.on("error", reject);
      req.end(body);
    });

  it("reads the whole body, whatever the Content-Type says", async () => {
    const s = await serve(undefined, (body, res) => res.end(body instanceof Error ? "error" : `${String(body.exceeded)}:${body.bytes.toString()}`));
    expect((await post(s.port, "hello", { "Content-Type": "application/x-www-form-urlencoded" })).text).toBe("false:hello");
    expect((await post(s.port, "")).text).toBe("false:");
    await s.close();
  });

  it("stops at the cap: the first `limit` bytes and a flag", async () => {
    const s = await serve(10, (body, res) => res.end(body instanceof Error ? "error" : `${String(body.exceeded)}:${body.bytes.toString()}`));
    expect((await post(s.port, "0123456789")).text).toBe("false:0123456789");
    expect((await post(s.port, "0123456789A")).text).toBe("true:0123456789");
    expect((await post(s.port, "x".repeat(100_000))).text).toBe("true:xxxxxxxxxx");
    await s.close();
  });

  it("the cap is 1 MiB", () => {
    expect(MAX_BODY_BYTES).toBe(1048576);
  });

  it("a caller who hangs up before the body is in is CallerGone", async () => {
    let seen: Error | undefined;
    const done = new Promise<void>((resolve) => {
      void serve(undefined, (body) => {
        seen = body instanceof Error ? body : undefined;
        resolve();
      }).then((s) => {
        const req = http.request({ port: s.port, host: "127.0.0.1", method: "POST", headers: { "Content-Length": "100" } });
        req.on("error", () => undefined);
        req.write("abc");
        setTimeout(() => req.destroy(), 50);
        void done.then(() => s.close());
      });
    });
    await done;
    expect(seen).toBeInstanceOf(CallerGone);
  });

  describe("decodeBody", () => {
    async function decodeVia(body: string) {
      const server = http.createServer((req, res) => {
        decodeBody(req, cargoTransactionRequestSchema).then(
          (v) => res.end(JSON.stringify({ ok: true, units: String(v.units) })),
          (e: unknown) => res.end(JSON.stringify({ ok: false, status: e instanceof TextAnswer ? e.status : 0, text: (e as Error).message })),
        );
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const out: unknown = JSON.parse((await post((server.address() as AddressInfo).port, body)).text);
      await new Promise((r) => server.close(r));
      return out as { ok: boolean; units?: string; status?: number; text?: string };
    }

    it("a refused body is the 400 `invalid request body: ` and the decoder's explanation", async () => {
      expect(await decodeVia('{"units":')).toEqual({ ok: false, status: 400, text: "invalid request body: unexpected EOF" });
      expect(await decodeVia("")).toEqual({ ok: false, status: 400, text: "invalid request body: EOF" });
      const bad = await decodeVia("not json");
      expect(bad.status).toBe(400);
      expect(bad.text).toMatch(/^invalid request body: .+/);
    });

    it("a value that is complete inside 1 MiB is used, whatever follows; one that runs past it is `too large`", async () => {
      const head = '{"units":7,"symbol":"';
      const exact = `${head}${"k".repeat(MAX_BODY_BYTES - head.length - 2)}"}`;
      expect(exact.length).toBe(MAX_BODY_BYTES);
      expect((await decodeVia(exact)).ok).toBe(true);
      expect((await decodeVia(`${exact}${"z".repeat(5000)}`)).ok).toBe(true);
      expect(await decodeVia(`${head}${"k".repeat(MAX_BODY_BYTES)}"}`)).toEqual({ ok: false, status: 400, text: `invalid request body: ${TOO_LARGE}` });
      // garbage is judged by its first bad byte, not by its size
      const garbage = await decodeVia("x".repeat(MAX_BODY_BYTES + 10));
      expect(garbage.text).toMatch(/^invalid request body: invalid character/);
    });
  });
});

describe("the query string is read like net/url", () => {
  const q = (raw: string) => new Query(raw);
  const get = (raw: string, name: string) => q(raw).get(name).toString("latin1");

  it("splits on & only, decodes % and +, and Get is the first value", () => {
    expect(get("a=1&b=2", "b")).toBe("2");
    expect(get("a=1&a=2", "a")).toBe("1");
    expect(get("a=&a=2", "a")).toBe("");
    expect(get("a=x+y%20z%2Bw", "a")).toBe("x y z+w");
    expect(get("a", "a")).toBe("");
    expect(get("a=b=c", "a")).toBe("b=c");
    expect(get("", "a")).toBe("");
    expect(get("&&a=1&&", "a")).toBe("1");
  });

  it("names are case sensitive and an unknown one is empty", () => {
    expect(get("Limit=1", "limit")).toBe("");
    expect(get("limit=1", "Limit")).toBe("");
  });

  it("a pair with a semicolon, or with a malformed escape in its name or value, is dropped", () => {
    expect(get("limit=2;x=1", "limit")).toBe("");
    expect(get("limit=2;x=1&type=SELL", "type")).toBe("SELL");
    expect(get("a=1&type=%zz&b=2", "type")).toBe("");
    expect(get("a=1&type=%zz&b=2", "b")).toBe("2");
    expect(get("%zz=1&b=2", "b")).toBe("2");
    expect(get("a=%", "a")).toBe("");
    expect(get("a=%4", "a")).toBe("");
    // a dropped first value lets a later one stand
    expect(get("a=%zz&a=2", "a")).toBe("2");
  });

  it("values are bytes: an escape can name a byte that is not UTF-8", () => {
    expect([...q("a=%FF%00").get("a")]).toEqual([0xff, 0]);
  });

  it("rawQueryOf is everything after the first ?", () => {
    expect(rawQueryOf("/a/b?x=1&y=2")).toBe("x=1&y=2");
    expect(rawQueryOf("/a/b")).toBe("");
    expect(rawQueryOf("/a/b?")).toBe("");
    expect(rawQueryOf("/a?b?c")).toBe("b?c");
  });

  describe("atoi (strconv.Atoi)", () => {
    const a = (s: string) => atoi(Buffer.from(s, "latin1"));
    it("accepts a sign and decimal digits, leading zeros included", () => {
      expect(a("5")).toBe(5n);
      expect(a("05")).toBe(5n);
      expect(a("+5")).toBe(5n);
      expect(a("-5")).toBe(-5n);
      expect(a("-0")).toBe(0n);
      expect(a("000000000000000000000004")).toBe(4n);
      expect(a("9223372036854775807")).toBe(9223372036854775807n);
      expect(a("-9223372036854775808")).toBe(-9223372036854775808n);
    });
    it("refuses everything else", () => {
      for (const bad of ["", " 5", "5 ", "1e3", "1.5", "0x10", "1_000", "1,000", "NaN", "null", "+", "-", "++5", "\u0661\u0662", "9223372036854775808", "-9223372036854775809", "99999999999999999999"]) {
        expect([bad, a(bad)]).toEqual([bad, null]);
      }
      expect(atoi(Buffer.from("\u0661\u0662", "utf8"))).toBeNull();
    });
  });
});
