/**
 * @file The query string the way Go reads it: `r.URL.Query()` (net/url ParseQuery) and `strconv.Atoi`.
 * Contract README note 36.
 *
 * Pairs are separated by `&` only. A pair that holds a `;`, or whose key or value has a malformed
 * `%` escape, is dropped as if it were not there (the rest is still read). `+` is a space. An empty
 * pair is skipped. Names are case-sensitive, and the first value of a repeated name is the one
 * `Get` returns, empty or not. Values are bytes: an escape can name a byte that is not UTF-8.
 */

import { unescapeBytes } from "./muxCompat";

export class Query {
  private readonly values = new Map<string, Buffer>();

  /** `raw` is everything after the `?`. */
  constructor(raw: string) {
    for (const pair of raw.split("&")) {
      if (pair === "" || pair.includes(";")) continue;
      const eq = pair.indexOf("=");
      const key = unescapeQuery(eq === -1 ? pair : pair.slice(0, eq));
      const value = unescapeQuery(eq === -1 ? "" : pair.slice(eq + 1));
      if (key === null || value === null) continue;
      const name = key.toString("latin1");
      if (!this.values.has(name)) this.values.set(name, value);
    }
  }

  /** url.Values.Get: the first value, or empty. */
  get(name: string): Buffer {
    return this.values.get(name) ?? Buffer.alloc(0);
  }
}

/** QueryUnescape: `+` is a space, `%XX` a byte; null for a malformed escape. */
function unescapeQuery(s: string): Buffer | null {
  return unescapeBytes(s.replace(/\+/g, " "));
}

/** Everything after the first `?` of a request target, or "". */
export function rawQueryOf(url: string): string {
  const q = url.indexOf("?");
  return q === -1 ? "" : url.slice(q + 1);
}

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/**
 * strconv.Atoi in base 10 (64-bit): an optional sign and one or more ASCII digits, nothing else;
 * null for anything else and for a value outside int64. `05` and `+5` are 5.
 */
export function atoi(raw: Buffer): bigint | null {
  const text = raw.toString("latin1");
  if (!/^[+-]?[0-9]+$/.test(text)) return null;
  const v = BigInt(text);
  return v < INT64_MIN || v > INT64_MAX ? null : v;
}
