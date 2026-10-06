/**
 * @file A JSON reader that loses nothing, and the matching writer.
 *
 * `JSON.parse` turns every number into a double (an int64 above 2^53 is
 * silently rounded), merges repeated keys, and cannot tell a raw string from
 * its unescaped value. The Go service's decoder can, and the contract
 * (README notes 19-23) pins what follows from it, so the gateway's answers are
 * read here instead: numbers stay literal text, objects stay lists of members
 * in source order (repeats included), strings are unescaped the way Go does it.
 *
 * Accepts and refuses what encoding/json's scanner does: RFC 8259 grammar, no
 * BOM, nothing after the value but whitespace, nesting of at most 10000. The
 * parser is iterative, so that limit is a counter and not a stack overflow.
 *
 * Strings from Go's `unquote`: each invalid UTF-8 byte is one U+FFFD (not
 * Node's "maximal subpart" replacement), a lone surrogate escape is U+FFFD, an
 * escaped pair is one character, raw control characters are a syntax error.
 */

export class JsonSyntaxError extends Error {
  /** True when the input ended where more was needed (Go: io.ErrUnexpectedEOF for a stream, "unexpected end of JSON input" for a buffer). */
  readonly eof: boolean;
  constructor(message: string, eof = false) {
    super(message);
    this.name = "JsonSyntaxError";
    this.eof = eof;
  }
}

export type JsonNode =
  | { readonly t: "null" }
  | { readonly t: "bool"; readonly v: boolean }
  /** The literal as written, e.g. "-12", "1.5", "1e3": a reader decides what it is. */
  | { readonly t: "num"; readonly raw: string }
  /** `plain` is true when the source text had no escape and no byte above 0x7f, so `v` is also what stood between the quotes. */
  | { readonly t: "str"; readonly v: string; readonly plain: boolean }
  | { readonly t: "arr"; readonly items: JsonNode[] }
  | { readonly t: "obj"; readonly members: (readonly [key: string, value: JsonNode])[] };

/** encoding/json's maxNestingDepth. */
export const MAX_DEPTH = 10000;
const NULL: JsonNode = { t: "null" };

const isWs = (c: number | undefined): boolean => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
const isDigit = (c: number | undefined): boolean => c !== undefined && c >= 0x30 && c <= 0x39;

/**
 * Length (1 to 4) of the well-formed UTF-8 sequence at b[i], or 0 when what is there is not one:
 * Go's utf8.DecodeRune says RuneError with width 1 for those, and so each bad byte is one U+FFFD.
 * Shortest form only, no surrogates, nothing above U+10FFFF.
 */
export function validLength(b: Uint8Array, i: number): number {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- the index is below the buffer length: the caller or the loop condition has checked it
  const b0 = b[i]!;
  if (b0 < 0x80) return 1;
  const cont = (k: number, lo = 0x80, hi = 0xbf): boolean => {
    const x = b[i + k];
    return x !== undefined && x >= lo && x <= hi;
  };
  if (b0 >= 0xc2 && b0 <= 0xdf) return cont(1) ? 2 : 0;
  // E0 needs A0..BF (no overlong), ED needs 80..9F (no surrogates).
  if (b0 >= 0xe0 && b0 <= 0xef) return cont(1, b0 === 0xe0 ? 0xa0 : 0x80, b0 === 0xed ? 0x9f : 0xbf) && cont(2) ? 3 : 0;
  // F0 needs 90..BF (no overlong), F4 needs 80..8F (<= U+10FFFF).
  if (b0 >= 0xf0 && b0 <= 0xf4) return cont(1, b0 === 0xf0 ? 0x90 : 0x80, b0 === 0xf4 ? 0x8f : 0xbf) && cont(2) && cont(3) ? 4 : 0;
  return 0;
}

const ESCAPES: Readonly<Record<number, string>> = { 0x22: '"', 0x5c: "\\", 0x2f: "/", 0x62: "\b", 0x66: "\f", 0x6e: "\n", 0x72: "\r", 0x74: "\t" };

interface Frame {
  readonly obj: boolean;
  readonly members: (readonly [string, JsonNode])[];
  readonly items: JsonNode[];
  key: string;
}

/** Parses exactly one JSON value; anything but whitespace after it is an error. */
export function parseJson(bytes: Uint8Array): JsonNode {
  return parse(bytes, false);
}

/**
 * Parses the first JSON value and ignores whatever follows it, unread and unchecked: what
 * `json.NewDecoder(r).Decode(v)` does with a request body. The value itself is checked whole
 * (the decoder scans it to its end before it binds anything).
 */
export function parseFirstJson(bytes: Uint8Array): JsonNode {
  return parse(bytes, true);
}

function parse(bytes: Uint8Array, ignoreRest: boolean): JsonNode {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = buf.length;
  let i = 0;

  const fail = (what: string): never => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- the index is below the buffer length: the caller or the loop condition has checked it
    throw new JsonSyntaxError(i >= n ? "unexpected end of JSON input" : `invalid character 0x${(buf[i]!).toString(16)} ${what}`, i >= n);
  };
  const ws = (): void => {
    while (isWs(buf[i])) i++;
  };

  /** A string starting at the opening quote; leaves i after the closing one. */
  const str = (): { v: string; plain: boolean } => {
    const start = ++i;
    // Fast path: printable ASCII up to the closing quote.
    while (i < n) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- the index is below the buffer length: the caller or the loop condition has checked it
      const c = buf[i]!;
      if (c === 0x22) {
        const v = buf.toString("latin1", start, i++);
        return { v, plain: true };
      }
      if (c === 0x5c || c >= 0x80) break;
      if (c < 0x20) fail("in string literal");
      i++;
    }
    // Slow path. Runs of well-formed text are cut out of the buffer whole; each bad byte is one U+FFFD.
    const parts: string[] = [];
    let run = start;
    const flush = (end: number): void => {
      if (end > run) parts.push(buf.toString("utf8", run, end));
    };
    while (i < n) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- the index is below the buffer length: the caller or the loop condition has checked it
      const c = buf[i]!;
      if (c === 0x22) {
        flush(i++);
        return { v: parts.join(""), plain: false };
      }
      if (c < 0x20) fail("in string literal");
      if (c === 0x5c) {
        flush(i);
        const e = buf[i + 1];
        if (e === 0x75) {
          let cp = hex4(i + 2);
          i += 6;
          if (cp >= 0xd800 && cp < 0xe000) {
            // A high surrogate followed by a low one is one character; any other surrogate is U+FFFD, and what follows is read on its own.
            const lo = cp < 0xdc00 && buf[i] === 0x5c && buf[i + 1] === 0x75 ? hex4(i + 2) : -1;
            if (lo >= 0xdc00 && lo < 0xe000) {
              cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
              i += 6;
            } else {
              cp = 0xfffd;
            }
          }
          parts.push(String.fromCodePoint(cp));
        } else if (e !== undefined && ESCAPES[e] !== undefined) {
          parts.push(ESCAPES[e]);
          i += 2;
        } else {
          i++;
          fail("in string escape code");
        }
        run = i;
      } else if (c < 0x80) {
        i++;
      } else {
        const len = validLength(buf, i);
        if (len > 0) {
          i += len;
        } else {
          flush(i);
          parts.push("�");
          run = ++i;
        }
      }
    }
    return fail("in string literal");
  };

  const hex4 = (at: number): number => {
    let v = 0;
    for (let k = 0; k < 4; k++) {
      const c = buf[at + k];
      const d = c === undefined ? -1 : c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x61 && c <= 0x66 ? c - 0x57 : c >= 0x41 && c <= 0x46 ? c - 0x37 : -1;
      if (d < 0) {
        i = at + k;
        return fail("in \\u hexadecimal character escape");
      }
      v = v * 16 + d;
    }
    return v;
  };

  const literal = (word: string, node: JsonNode): JsonNode => {
    for (let k = 0; k < word.length; k++) {
      if (buf[i + k] !== word.charCodeAt(k)) {
        i += k;
        return fail(`in literal ${word}`);
      }
    }
    i += word.length;
    return node;
  };

  const number = (): JsonNode => {
    const start = i;
    if (buf[i] === 0x2d) i++;
    if (buf[i] === 0x30) i++;
    else if (isDigit(buf[i])) while (isDigit(buf[i])) i++;
    else fail("in numeric literal");
    if (buf[i] === 0x2e) {
      i++;
      if (!isDigit(buf[i])) fail("after decimal point in numeric literal");
      while (isDigit(buf[i])) i++;
    }
    if (buf[i] === 0x65 || buf[i] === 0x45) {
      i++;
      if (buf[i] === 0x2b || buf[i] === 0x2d) i++;
      if (!isDigit(buf[i])) fail("in exponent of numeric literal");
      while (isDigit(buf[i])) i++;
    }
    return { t: "num", raw: buf.toString("latin1", start, i) };
  };

  const key = (): string => {
    ws();
    if (buf[i] !== 0x22) fail("looking for beginning of object key string");
    const k = str().v;
    ws();
    if (buf[i] !== 0x3a) fail("after object key");
    i++;
    return k;
  };

  const stack: Frame[] = [];
  let value: JsonNode | undefined;
  for (;;) {
    if (value === undefined) {
      ws();
      const c = buf[i];
      if (c === 0x7b || c === 0x5b) {
        if (stack.length >= MAX_DEPTH) fail("(exceeded max depth)");
        const obj = c === 0x7b;
        i++;
        ws();
        if (buf[i] === (obj ? 0x7d : 0x5d)) {
          i++;
          value = obj ? { t: "obj", members: [] } : { t: "arr", items: [] };
        } else {
          const frame: Frame = { obj, members: [], items: [], key: "" };
          if (obj) frame.key = key();
          stack.push(frame);
          continue;
        }
      } else if (c === 0x22) {
        const s = str();
        value = { t: "str", v: s.v, plain: s.plain };
      } else if (c === 0x74) value = literal("true", { t: "bool", v: true });
      else if (c === 0x66) value = literal("false", { t: "bool", v: false });
      else if (c === 0x6e) value = literal("null", NULL);
      else if (c === 0x2d || isDigit(c)) value = number();
      else return fail("looking for beginning of value");
    }
    const top = stack[stack.length - 1];
    if (top === undefined) {
      if (ignoreRest) return value;
      ws();
      if (i < n) fail("after top-level value");
      return value;
    }
    if (top.obj) top.members.push([top.key, value]);
    else top.items.push(value);
    value = undefined;
    ws();
    const c = buf[i];
    if (c === 0x2c) {
      i++;
      if (top.obj) top.key = key();
    } else if (c === (top.obj ? 0x7d : 0x5d)) {
      i++;
      stack.pop();
      value = top.obj ? { t: "obj", members: top.members } : { t: "arr", items: top.items };
    } else {
      fail(top.obj ? "after object key:value pair" : "after array element");
    }
  }
}

/**
 * A time Go reads but cannot write: its zone offset is a day or more. Go's encoder fails on it, so
 * the answer that carries it is a 200 with an empty body (writeJSON drops the error). It travels in
 * a time field in place of the string; writing it throws.
 */
export class UnencodableTime {
  readonly source: string;
  constructor(source: string) {
    this.source = source;
  }
  toString(): string {
    return this.source;
  }
}

/** True when the value holds a time Go could not encode (see UnencodableTime). */
export function hasUnencodable(value: unknown): boolean {
  if (value instanceof UnencodableTime) return true;
  if (Array.isArray(value)) return value.some(hasUnencodable);
  return typeof value === "object" && value !== null && Object.values(value).some(hasUnencodable);
}

/**
 * A float64 the way encoding/json writes it: the shortest text that reads back as the same double,
 * plain from 1e-6 up to (not including) 1e21 and in exponent form outside that, with a two-digit
 * exponent cut to one ("1e-7", "1e+21"). Number#toString switches at the same two bounds and writes
 * the same digits and exponent; the one difference is negative zero, which Go writes as "-0". NaN
 * and the infinities are unsupported values in Go; the decoder never produces them.
 */
export function goFloat(v: number): string {
  if (!Number.isFinite(v)) throw new TypeError(`json: unsupported value: ${String(v)}`);
  return Object.is(v, -0) ? "-0" : String(v);
}

/** The text of a value built from null, booleans, strings, bigints (written as integers of any size), numbers (as Go writes a float64), arrays and plain objects, as pieces of modest size. Throws on what Go could not encode. */
export function* jsonPieces(value: unknown): Generator<string> {
  if (value === null) yield "null";
  else if (typeof value === "bigint") yield value.toString();
  else if (typeof value === "number") yield goFloat(value);
  else if (typeof value === "boolean") yield value ? "true" : "false";
  else if (typeof value === "string") yield JSON.stringify(value);
  else if (value instanceof UnencodableTime) throw new TypeError("a time Go cannot encode: zone offset of a day or more");
  else if (Array.isArray(value)) {
    yield "[";
    let first = true;
    for (const item of value) {
      if (!first) yield ",";
      first = false;
      yield* jsonPieces(item);
    }
    yield "]";
  } else if (typeof value === "object") {
    yield "{";
    let first = true;
    for (const [k, v] of Object.entries(value)) {
      yield `${first ? "" : ","}${JSON.stringify(k)}:`;
      first = false;
      yield* jsonPieces(v);
    }
    yield "}";
  } else throw new TypeError(`jsonPieces: cannot write a ${typeof value}`);
}

/**
 * The same as one string, for values known to be small. Strings go through JSON.stringify; Go would
 * also write `<`, `>`, `&`, U+2028 and U+2029 as escapes, which is the same string after parsing.
 */
export const stringifyJson = (value: unknown): string => Array.from(jsonPieces(value)).join("");
