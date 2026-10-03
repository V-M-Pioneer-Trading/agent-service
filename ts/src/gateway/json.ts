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
  constructor(message: string) {
    super(message);
    this.name = "JsonSyntaxError";
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
  | { readonly t: "obj"; readonly members: Array<readonly [key: string, value: JsonNode]> };

/** encoding/json's maxNestingDepth. */
export const MAX_DEPTH = 10000;
const NULL: JsonNode = { t: "null" };

const isWs = (c: number | undefined): boolean => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
const isDigit = (c: number | undefined): boolean => c !== undefined && c >= 0x30 && c <= 0x39;

/**
 * Go's utf8.DecodeRune on bytes[i..]: the code point and its length, or
 * U+FFFD with length 1 for anything that is not a well-formed, shortest-form,
 * non-surrogate sequence.
 */
export function decodeRune(b: Uint8Array, i: number): readonly [codePoint: number, length: number] {
  const b0 = b[i] as number;
  if (b0 < 0x80) return [b0, 1];
  const cont = (k: number, lo = 0x80, hi = 0xbf): number | undefined => {
    const x = b[i + k];
    return x !== undefined && x >= lo && x <= hi ? x & 0x3f : undefined;
  };
  if (b0 >= 0xc2 && b0 <= 0xdf) {
    const c1 = cont(1);
    if (c1 !== undefined) return [((b0 & 0x1f) << 6) | c1, 2];
  } else if (b0 >= 0xe0 && b0 <= 0xef) {
    // E0 needs A0..BF (no overlong), ED needs 80..9F (no surrogates).
    const c1 = cont(1, b0 === 0xe0 ? 0xa0 : 0x80, b0 === 0xed ? 0x9f : 0xbf);
    const c2 = cont(2);
    if (c1 !== undefined && c2 !== undefined) return [((b0 & 0x0f) << 12) | (c1 << 6) | c2, 3];
  } else if (b0 >= 0xf0 && b0 <= 0xf4) {
    // F0 needs 90..BF (no overlong), F4 needs 80..8F (<= U+10FFFF).
    const c1 = cont(1, b0 === 0xf0 ? 0x90 : 0x80, b0 === 0xf4 ? 0x8f : 0xbf);
    const c2 = cont(2);
    const c3 = cont(3);
    if (c1 !== undefined && c2 !== undefined && c3 !== undefined) return [((b0 & 0x07) << 18) | (c1 << 12) | (c2 << 6) | c3, 4];
  }
  return [0xfffd, 1];
}

const ESCAPES: Readonly<Record<number, string>> = { 0x22: '"', 0x5c: "\\", 0x2f: "/", 0x62: "\b", 0x66: "\f", 0x6e: "\n", 0x72: "\r", 0x74: "\t" };

interface Frame {
  readonly obj: boolean;
  readonly members: Array<readonly [string, JsonNode]>;
  readonly items: JsonNode[];
  key: string;
}

/** Parses exactly one JSON value; anything but whitespace after it is an error. */
export function parseJson(bytes: Uint8Array): JsonNode {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = buf.length;
  let i = 0;

  const fail = (what: string): never => {
    throw new JsonSyntaxError(i >= n ? "unexpected end of JSON input" : `invalid character 0x${(buf[i] as number).toString(16)} ${what}`);
  };
  const ws = (): void => {
    while (isWs(buf[i])) i++;
  };

  /** A string starting at the opening quote; leaves i after the closing one. */
  const str = (): { v: string; plain: boolean } => {
    const start = ++i;
    // Fast path: printable ASCII up to the closing quote.
    while (i < n) {
      const c = buf[i] as number;
      if (c === 0x22) {
        const v = buf.toString("latin1", start, i++);
        return { v, plain: true };
      }
      if (c === 0x5c || c >= 0x80) break;
      if (c < 0x20) fail("in string literal");
      i++;
    }
    let out = buf.toString("latin1", start, i);
    while (i < n) {
      const c = buf[i] as number;
      if (c === 0x22) {
        i++;
        return { v: out, plain: false };
      }
      if (c < 0x20) fail("in string literal");
      if (c === 0x5c) {
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
          out += String.fromCodePoint(cp);
        } else if (e !== undefined && ESCAPES[e] !== undefined) {
          out += ESCAPES[e];
          i += 2;
        } else {
          i++;
          fail("in string escape code");
        }
      } else if (c < 0x80) {
        out += String.fromCharCode(c);
        i++;
      } else {
        const [cp, len] = decodeRune(buf, i);
        out += String.fromCodePoint(cp);
        i += len;
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
 * JSON text for a value built from null, booleans, strings, bigints (written
 * as integers, whatever their size), arrays and plain objects. Strings go
 * through JSON.stringify; Go would also write `<`, `>`, `&`, U+2028 and U+2029
 * as escapes, which is the same string after parsing.
 */
export function stringifyJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "bigint":
      return value.toString();
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "object":
      if (Array.isArray(value)) return `[${value.map(stringifyJson).join(",")}]`;
      return `{${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}:${stringifyJson(v)}`).join(",")}}`;
    default:
      throw new TypeError(`stringifyJson: cannot write a ${typeof value}`);
  }
}
