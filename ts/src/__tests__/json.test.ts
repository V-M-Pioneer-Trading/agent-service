import { JsonSyntaxError, MAX_DEPTH, parseJson, stringifyJson, type JsonNode } from "../gateway/json";

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
  it("refuses what it cannot write exactly", () => {
    expect(() => stringifyJson({ n: 1 })).toThrow(TypeError);
  });
});

describe("sendJson writes in pieces", () => {
  it("a 3 MB answer goes out in several writes, waits for drain, and ends with a newline", async () => {
    const writes: string[] = [];
    let drained = 0;
    const listeners: Record<string, () => void> = {};
    const res = {
      statusCode: 0,
      destroyed: false,
      headers: {} as Record<string, string>,
      setHeader(k: string, v: string) {
        this.headers[k] = v;
      },
      write(chunk: string) {
        writes.push(chunk);
        return writes.length % 2 === 0; // every other write says "slow down"
      },
      once(event: string, fn: () => void) {
        listeners[event] = fn;
        if (event === "drain") setTimeout(() => ((drained += 1), fn()), 0);
      },
      end(chunk?: string) {
        if (chunk !== undefined) writes.push(chunk);
      },
    };
    const value = Array.from({ length: 60000 }, (_, k) => ({ n: BigInt(k), s: "x".repeat(40) }));
    const { sendJson } = await import("../http/json");
    await sendJson(res as never, value);
    expect(writes.length).toBeGreaterThan(2);
    expect(drained).toBeGreaterThan(0);
    const text = writes.join("");
    expect(text.endsWith("]\n")).toBe(true);
    expect(text.length).toBeGreaterThan(3 << 20);
    expect(JSON.parse(text)).toHaveLength(60000);
    expect([res.statusCode, res.headers["Content-Type"]]).toEqual([200, "application/json"]);
  });
});
