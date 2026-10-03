/**
 * @file Typed decoding of the gateway's JSON: what Go's `json.Unmarshal` into
 * a struct does, and nothing a JavaScript object would do by itself.
 *
 * A schema is built from `text`, `int64`, `bool`, `time`, `list(of)` and
 * `struct({...})`. `decode(schema, bytes)` returns a value of exactly that
 * shape (see `Decoded`), following contract/README.md notes 19-24:
 *
 *  - missing members are zero values ("", 0n, false, the zero time); a missing
 *    list is `null`; an empty one stays `[]`; unknown members are dropped; a
 *    JSON `null` changes nothing (so it is a zero value unless an earlier
 *    repeat of the key already set one), except that it resets a list to null;
 *  - member names match case-insensitively under Go's simple Unicode folding,
 *    not with other punctuation; the last repeat wins, and a repeated object
 *    or array is merged into the earlier one, like Go does;
 *  - integers are int64: bigint, exact, and "1.5", "5.0", "1e3" or a value out
 *    of range are errors, not coerced;
 *  - times are RFC 3339 only and come back normalised the way Go writes them;
 *  - anything that does not fit is a `DecodeError` (the caller answers 502).
 *
 * An empty body is the zero value. A body of only whitespace is a syntax error.
 */

import { JsonSyntaxError, parseJson, UnencodableTime, type JsonNode } from "./json";

export class DecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecodeError";
  }
}

// --- schemas ---------------------------------------------------------------

export type Schema =
  | { readonly kind: "string" }
  | { readonly kind: "int" }
  | { readonly kind: "bool" }
  | { readonly kind: "time" }
  | { readonly kind: "list"; readonly of: Schema }
  | { readonly kind: "struct"; readonly fields: Readonly<Record<string, Schema>>; readonly lookup: FieldLookup };

type FieldLookup = { readonly exact: ReadonlyMap<string, string>; readonly folded: ReadonlyMap<string, string> };

export const text = { kind: "string" } as const;
export const int64 = { kind: "int" } as const;
export const bool = { kind: "bool" } as const;
export const time = { kind: "time" } as const;
export const list = <S extends Schema>(of: S) => ({ kind: "list", of }) as const;
export function struct<F extends Record<string, Schema>>(fields: F) {
  const names = Object.keys(fields);
  const lookup: FieldLookup = {
    exact: new Map(names.map((n) => [n, n])),
    folded: new Map(names.map((n) => [foldName(n), n])),
  };
  return { kind: "struct", fields, lookup } as const;
}

/** The value a schema decodes to. int64 is bigint, a list is `null` when absent, a time is its normalised text. */
export type Decoded<S> = S extends { kind: "string" | "time" }
  ? string
  : S extends { kind: "int" }
    ? bigint
    : S extends { kind: "bool" }
      ? boolean
      : S extends { kind: "list"; of: infer E }
        ? Array<Decoded<E>> | null
        : S extends { kind: "struct"; fields: infer F }
          ? { -readonly [K in keyof F]: Decoded<F[K]> }
          : never;

// --- member names ----------------------------------------------------------

const single = (s: string): string | undefined => (s.length === 1 || (s.length === 2 && s.codePointAt(0)! > 0xffff) ? s : undefined);

/**
 * One code point under Go's simple folding (what bytes.EqualFold compares by):
 * the lower case of the upper case, when each is a single code point. That
 * puts 'ſ' with 's', the Kelvin sign with 'k', 'ς' with 'σ' and 'ẞ' with 'ß',
 * and leaves 'ß' (upper case "SS"), 'İ' and 'ı' alone, as Go does.
 */
function foldRune(ch: string): string {
  if (ch.codePointAt(0) === 0x131) return ch;
  const upper = single(ch.toUpperCase()) ?? ch;
  return single(upper.toLowerCase()) ?? upper;
}

export const foldName = (name: string): string => Array.from(name, foldRune).join("");

// --- scalars ---------------------------------------------------------------

export const ZERO_TIME = "0001-01-01T00:00:00Z";
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
// Go 1.25 reads times with the lenient time.Parse (its strict RFC 3339 check is not applied): the hour may be
// one digit, the fraction may follow a comma, the zone offset may say minute 60 or hour 24.
const TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{1,2}):(\d{2}):(\d{2})(?:[.,](\d+))?(?:Z|([+-])(\d{2}):(\d{2}))$/;

const isLeap = (y: number): boolean => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
const daysIn = (month: number, year: number): number => (month === 2 ? (isLeap(year) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31);

/**
 * time.Time.UnmarshalJSON then MarshalJSON, as Go 1.25 does them: time.Parse with the RFC 3339
 * layout (upper-case T and Z, a zone, no leap second, fraction digits beyond the ninth cut off,
 * leniencies above), written with the zone offset it came with, recomputed ("+00:60" is "+01:00",
 * any zero offset is "Z"), and the shortest exact fraction. `text` is the source text between
 * the quotes, exactly as written.
 */
export function normaliseTime(text: string): string | UnencodableTime {
  const m = TIME_RE.exec(text);
  if (m === null) throw new DecodeError(`parsing time ${JSON.stringify(text)} as RFC 3339: not an RFC 3339 time`);
  const [year, month, day, hour, min, sec] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number) as [number, number, number, number, number, number];
  const offHour = m[9] === undefined ? 0 : Number(m[9]);
  const offMin = m[10] === undefined ? 0 : Number(m[10]);
  if (month < 1 || month > 12 || day < 1 || day > daysIn(month, year) || hour > 23 || min > 59 || sec > 59 || offHour > 24 || offMin > 60) {
    throw new DecodeError(`parsing time ${JSON.stringify(text)}: field out of range`);
  }
  const offset = (offHour * 60 + offMin) * 60;
  if (offset >= 86400) return new UnencodableTime(text);
  const fraction = (m[7] ?? "").slice(0, 9).replace(/0+$/, "");
  const two = (n: number): string => String(n).padStart(2, "0");
  const zone = offset === 0 ? "Z" : `${m[8]}${two(Math.floor(offset / 3600))}:${two((offset % 3600) / 60)}`;
  return `${m[1]}-${m[2]}-${m[3]}T${two(hour)}:${m[5]}:${m[6]}${fraction === "" ? "" : `.${fraction}`}${zone}`;
}

/** strconv.ParseInt(literal, 10, 64): digits only, so no fraction and no exponent. */
function parseInt64(raw: string): bigint {
  if (!/^-?\d+$/.test(raw)) throw new DecodeError(`cannot unmarshal number ${raw} into an int64`);
  const v = BigInt(raw);
  if (v < INT64_MIN || v > INT64_MAX) throw new DecodeError(`cannot unmarshal number ${raw} into an int64: out of range`);
  return v;
}

// --- binding ---------------------------------------------------------------

export function zero(schema: Schema): unknown {
  switch (schema.kind) {
    case "string":
      return "";
    case "int":
      return 0n;
    case "bool":
      return false;
    case "time":
      return ZERO_TIME;
    case "list":
      return null;
    case "struct":
      return Object.fromEntries(Object.entries(schema.fields).map(([name, field]) => [name, zero(field)]));
  }
}

const NODE_NAMES = { null: "null", bool: "bool", num: "number", str: "string", arr: "array", obj: "object" } as const;
const mismatch = (node: JsonNode, want: string): DecodeError => new DecodeError(`cannot unmarshal ${NODE_NAMES[node.t]} into a value of type ${want}`);

/** `existing` is what an earlier repeat of the same member produced: null changes nothing, objects and arrays merge into it. */
function bind(node: JsonNode, schema: Schema, existing: unknown): unknown {
  // null is a no-op in Go, except that it sets a slice to nil.
  if (node.t === "null") return schema.kind === "list" ? null : (existing ?? zero(schema));
  switch (schema.kind) {
    case "string":
      if (node.t !== "str") throw mismatch(node, "string");
      return node.v;
    case "bool":
      if (node.t !== "bool") throw mismatch(node, "bool");
      return node.v;
    case "int":
      if (node.t !== "num") throw mismatch(node, "int64");
      return parseInt64(node.raw);
    case "time":
      // Go parses the text between the quotes without unescaping it: an escape, or anything that is not ASCII, can never be a time.
      if (node.t !== "str") throw mismatch(node, "time.Time");
      if (!node.plain) throw new DecodeError("parsing time: an escape or a non-ASCII character is not RFC 3339");
      // An UnencodableTime travels in the field in place of its string; only the writer ever meets it (json.ts).
      return normaliseTime(node.v) as string;
    case "list": {
      if (node.t !== "arr") throw mismatch(node, "array");
      const before = Array.isArray(existing) ? (existing as unknown[]) : [];
      return node.items.map((item, k) => bind(item, schema.of, before[k]));
    }
    case "struct": {
      if (node.t !== "obj") throw mismatch(node, "object");
      const into = (existing ?? zero(schema)) as Record<string, unknown>;
      for (const [key, value] of node.members) {
        const name = schema.lookup.exact.get(key) ?? schema.lookup.folded.get(foldName(key));
        if (name !== undefined) into[name] = bind(value, schema.fields[name] as Schema, into[name]);
      }
      return into;
    }
  }
}

/** Decodes a gateway body. An empty one is the zero value; anything that does not fit is a DecodeError. */
export function decode<S extends Schema>(schema: S, body: Uint8Array): Decoded<S> {
  if (body.length === 0) return zero(schema) as Decoded<S>;
  let node: JsonNode;
  try {
    node = parseJson(body);
  } catch (err) {
    if (err instanceof JsonSyntaxError) throw new DecodeError(err.message);
    throw err;
  }
  return bind(node, schema, undefined) as Decoded<S>;
}
