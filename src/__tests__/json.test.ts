import { decode, float64, struct } from "../gateway/decode";
import { JsonSyntaxError, MAX_DEPTH, parseJson, stringifyJson, validLength, type JsonNode } from "../gateway/json";

const parse = (s: string | number[]): JsonNode => parseJson(typeof s === "string" ? Buffer.from(s) : Uint8Array.from(s));
const str = (s: string | number[]): string => {
  const n = parse(s);
  if (n.t !== "str") throw new Error("not a string");
  return n.v;
};

describe("parseJson: nothing is lost", () => {
  it("keeps numbers as written, beyond 2^53 and with fractions or exponents", () => {
    expect(parse("9007199254740993")).toEqual({ t: "num", raw: "9007199254740993" });
    expect(parse("-9223372036854775808")).toEqual({ t: "num", raw: "-9223372036854775808" });
    for (const raw of ["1.5", "5.0", "1e3", "-0", "1E+2", "0.1e-5"]) expect(parse(raw)).toEqual({ t: "num", raw });
  });

  it("keeps repeated keys, in order", () => {
    const n = parse('{"a":1,"A":2,"a":3}');
    expect(n.t === "obj" && n.members.map(([k]) => k)).toEqual(["a", "A", "a"]);
  });

  it("marks a string plain only when its text is its value", () => {
    expect(parse('"abc"')).toMatchObject({ v: "abc", plain: true });
    expect(parse('"a\\u0062c"')).toMatchObject({ v: "abc", plain: false });
    expect(parse('"é"')).toMatchObject({ v: "é", plain: false });
  });
});

describe("parseJson: strings are unquoted like Go does", () => {
  it("replaces each invalid UTF-8 byte by one U+FFFD", () => {
    expect(str([0x22, 0xff, 0xfe, 0x22])).toBe("\ufffd\ufffd");
    // A truncated three-byte sequence is two bad bytes in Go (Node's decoder would write one replacement).
    expect(str([0x22, 0xe2, 0x82, 0x22])).toBe("\ufffd\ufffd");
    // Overlong, surrogate and beyond-Unicode encodings are invalid byte by byte.
    expect(str([0x22, 0xe0, 0x80, 0x80, 0x22])).toBe("���");
    expect(str([0x22, 0xf0, 0x80, 0x80, 0x80, 0x22])).toBe("����");
    expect(str([0x22, 0xe0, 0xa0, 0x80, 0x22])).toBe("ࠀ");
    expect(str([0x22, 0xc0, 0x80, 0x22])).toBe("\ufffd\ufffd");
    expect(str([0x22, 0xed, 0xa0, 0x80, 0x22])).toBe("\ufffd\ufffd\ufffd");
    expect(str([0x22, 0xf4, 0x90, 0x80, 0x80, 0x22])).toBe("\ufffd\ufffd\ufffd\ufffd");
  });

  it("reads valid multi-byte text as is", () => {
    expect(str('"é日\u{1F600}"')).toBe("é日\u{1F600}");
  });

  it("joins a surrogate pair and replaces a lone surrogate, reading what follows on its own", () => {
    expect(str('"\\ud83d\\ude00"')).toBe("\u{1F600}");
    expect(str('"x\\ud83dy"')).toBe("x\ufffdy");
    expect(str('"\\ude00"')).toBe("\ufffd");
    expect(str('"\\ud83d\\u0041"')).toBe("\ufffdA");
    expect(str('"\\ud83d\\ud83d\\ude00"')).toBe("\ufffd\u{1F600}");
  });

  it("decodes every escape; \\u0000..\\u001f are fine, raw control characters are not", () => {
    expect(str('"\\"\\\\\\/\\b\\f\\n\\r\\t\\u0000\\u001f"')).toBe('"\\/\b\f\n\r\t\u0000\u001f');
    expect(() => parse('"a\nb"')).toThrow(JsonSyntaxError);
    expect(() => parse('"\\x"')).toThrow(JsonSyntaxError);
    expect(() => parse('"\\u12g4"')).toThrow(JsonSyntaxError);
  });
});

describe("parseJson: the grammar of encoding/json's scanner", () => {
  it.each(["", "   ", "{", "[1,]", '{"a":}', '{"a" 1}', "{a:1}", "01", "1.", ".5", "+1", "-", "1e", "tru", "nulll", "'a'", "\ufeff{}", "{}x", "{} {}", "[1 2]", '{"a":1,}', '"abc'])(
    "refuses %j",
    (text) => {
      expect(() => parse(text)).toThrow(JsonSyntaxError);
    },
  );

  it.each(["{}", "[]", " \t\r\n[1, 2 ,3]\n", '{"a":{"b":[null,true,false,"x",-1.5e+3]}}', "null", '""', "0", "-0"])("accepts %j", (text) => {
    expect(() => parse(text)).not.toThrow();
  });

  it("allows nesting of 10000 and refuses 10001, without overflowing the stack", () => {
    expect(() => parse("[".repeat(MAX_DEPTH) + "]".repeat(MAX_DEPTH))).not.toThrow();
    expect(() => parse("[".repeat(MAX_DEPTH + 1) + "]".repeat(MAX_DEPTH + 1))).toThrow(/max depth/);
    expect(() => parse("[".repeat(100000))).toThrow(JsonSyntaxError);
  });
});

describe("stringifyJson", () => {
  it("writes bigints as integers of any size, in key order", () => {
    expect(stringifyJson({ b: 9223372036854775807n, a: [null, true, "x\n", -5n], c: {} })).toBe('{"b":9223372036854775807,"a":[null,true,"x\\n",-5],"c":{}}');
  });
  it("refuses what Go could not write", () => {
    expect(() => stringifyJson({ n: NaN })).toThrow(TypeError);
    expect(() => stringifyJson({ n: Infinity })).toThrow(TypeError);
    expect(() => stringifyJson({ n: -Infinity })).toThrow(TypeError);
    expect(() => stringifyJson({ n: undefined })).toThrow(TypeError);
  });
  // What Go 1.22's json.Marshal writes for a float64 decoded from each literal (go run, recorded): the
  // 'f'/'e' switch at 1e-6 and 1e21, the shortest digits, "e-07" cut to "e-7", negative zero as "-0".
  it.each([
    ["0.999", "0.999"],
    ["0.5", "0.5"],
    ["1", "1"],
    ["100", "100"],
    ["1E2", "100"],
    ["0.1", "0.1"],
    ["-0", "-0"],
    ["0", "0"],
    ["1e-400", "0"],
    ["0.000001", "0.000001"],
    ["0.0000009999", "9.999e-7"],
    ["1e-7", "1e-7"],
    ["1.5e-7", "1.5e-7"],
    ["2.5e-10", "2.5e-10"],
    ["5e-324", "5e-324"],
    ["1e20", "100000000000000000000"],
    ["999999999999999999999", "1e+21"],
    ["1e21", "1e+21"],
    ["123456789012345678901234", "1.2345678901234569e+23"],
    ["1e100", "1e+100"],
    ["1.7976931348623157e308", "1.7976931348623157e+308"],
    ["9007199254740993", "9007199254740992"],
  ])("writes a float64 read from %s as Go does: %s", (literal, go) => {
    expect(stringifyJson({ c: decode(struct({ c: float64 }), Buffer.from(`{"c":${literal}}`)).c })).toBe(`{"c":${go}}`);
  });
});

describe("sendJson writes in pieces", () => {
  /** A response that records its writes, says "slow down" on every other one, and counts its listeners. */
  function fakeResponse(opts: { destroyAfterFirstWrite?: boolean } = {}) {
    const writes: string[] = [];
    const listeners = new Map<string, Set<() => void>>();
    const count = (): number => Array.from(listeners.values()).reduce((n, set) => n + set.size, 0);
    const res = {
      statusCode: 0,
      destroyed: false,
      headers: {} as Record<string, string>,
      maxListeners: 0,
      setHeader(k: string, v: string) {
        this.headers[k] = v;
      },
      write(chunk: string) {
        writes.push(chunk);
        if (opts.destroyAfterFirstWrite === true) this.destroyed = true;
        return writes.length % 2 === 0;
      },
      on(event: string, fn: () => void) {
        const set = listeners.get(event) ?? new Set();
        listeners.set(event, set.add(fn));
        this.maxListeners = Math.max(this.maxListeners, count());
        if (event === "drain") setTimeout(() => listeners.get("drain")?.forEach((f) => { f(); }), 0);
      },
      off(event: string, fn: () => void) {
        listeners.get(event)?.delete(fn);
      },
      end(chunk?: string) {
        if (chunk !== undefined) writes.push(chunk);
      },
    };
    return { res, writes, count };
  }
  const big = (n: number) => Array.from({ length: n }, (_, k) => ({ n: BigInt(k), s: "x".repeat(40) }));

  it("a 3 MB answer goes out in several writes, waits for drain, and ends with a newline", async () => {
    const { res, writes } = fakeResponse();
    const { sendJson } = await import("../http/json");
    await sendJson(res as never, big(60000));
    expect(writes.length).toBeGreaterThan(2);
    const text = writes.join("");
    expect(text.endsWith("]\n")).toBe(true);
    expect(text.length).toBeGreaterThan(3 << 20);
    expect(JSON.parse(text)).toHaveLength(60000);
    expect([res.statusCode, res.headers["Content-Type"]]).toEqual([200, "application/json"]);
  });

  it("leaves no drain or close listener behind, however often it waits", async () => {
    const { res, writes, count } = fakeResponse();
    const { sendJson } = await import("../http/json");
    await sendJson(res as never, big(200000));
    expect(writes.length).toBeGreaterThan(8);
    expect(count()).toBe(0);
    expect(res.maxListeners).toBeLessThanOrEqual(2);
  });

  it("does not serialise the rest for a caller who is gone", async () => {
    let reads = 0;
    const rows = big(60000);
    const watched = new Proxy(rows, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && /^\d+$/.test(prop)) reads += 1;
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    const { res, writes } = fakeResponse({ destroyAfterFirstWrite: true });
    const { sendJson } = await import("../http/json");
    await sendJson(res as never, watched);
    expect(writes).toHaveLength(1);
    // One pass for the check that Go could encode it (60000 reads), then only as many as were written.
    expect(reads).toBeLessThan(100000);
  });
});

describe("validLength", () => {
  it("is 1 for ASCII, 2 to 4 for well-formed sequences, and 0 for what is not a start byte", () => {
    expect(validLength(Uint8Array.of(0x00), 0)).toBe(1);
    expect(validLength(Uint8Array.of(0x7f), 0)).toBe(1);
    expect(validLength(Uint8Array.of(0xc3, 0xa9), 0)).toBe(2);
    expect(validLength(Uint8Array.of(0xe2, 0x82, 0xac), 0)).toBe(3);
    expect(validLength(Uint8Array.of(0xf0, 0x9f, 0x98, 0x80), 0)).toBe(4);
    expect(validLength(Uint8Array.of(0xc0, 0x80), 0)).toBe(0);
    expect(validLength(Uint8Array.of(0xff), 0)).toBe(0);
  });

  // 0x80 is the first byte that is not ASCII: a continuation byte with no lead before it is invalid, and `b0 <= 0x80` in the ASCII test would call it one character.
  it.each([0x80, 0x81, 0xbf])("says a lone continuation byte %i is not a character", (byte) => {
    expect(validLength(Uint8Array.of(byte), 0)).toBe(0);
    expect(validLength(Uint8Array.of(0x41, byte, 0x41), 1)).toBe(0);
  });
});
