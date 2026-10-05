/**
 * @file Times on their way into and out of MySQL, the way the Go service does them with
 * go-sql-driver/mysql (src/db) and `time.Time`.
 *
 * The session time zone is UTC (pool.ts), so a time is sent as the UTC text
 * `YYYY-MM-DD HH:MM:SS[.ffffff]`, microseconds truncated like the driver does. MySQL rounds a
 * TIMESTAMP(0) to the whole second on its own (".4" down, ".6" up) and refuses what is outside
 * 1970..2038; the insert then fails and the caller's best-effort persistence logs it.
 */

import { timeInstant } from "../gateway/decode";
import { UnencodableTime } from "../gateway/json";

/** An instant: whole seconds since the Unix epoch, and the nanoseconds. */
export interface Instant {
  readonly seconds: number;
  readonly nanos: number;
}

/** Seconds from the epoch to 0001-01-01T00:00:00Z, Go's zero time. */
const ZERO_SECONDS = -62135596800;

export const instantOfDate = (date: Date): Instant => {
  const ms = date.getTime();
  const seconds = Math.floor(ms / 1000);
  return { seconds, nanos: (ms - seconds * 1000) * 1_000_000 };
};

/** The instant a decoded time field holds (a normalised text, or the source of one Go reads but cannot write). */
export const instantOfTime = (value: string | UnencodableTime): Instant => timeInstant(value instanceof UnencodableTime ? value.source : value);

/** Go's `time.Time.IsZero`. */
export const isZeroTime = (t: Instant): boolean => t.seconds === ZERO_SECONDS && t.nanos === 0;

const pad = (n: number, width: number): string => String(n).padStart(width, "0");

/** The UTC fields of an instant. A year outside 1..9999 is an error, as it is for the driver. */
function fields(t: Instant): { date: string; clock: string } {
  const d = new Date(t.seconds * 1000);
  const year = d.getUTCFullYear();
  if (year < 1 || year > 9999) throw new RangeError(`time.Time year must be in range [1,9999], got ${String(year)}`);
  return {
    date: `${pad(year, 4)}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)}`,
    clock: `${pad(d.getUTCHours(), 2)}:${pad(d.getUTCMinutes(), 2)}:${pad(d.getUTCSeconds(), 2)}`,
  };
}

/** The parameter text for a TIMESTAMP column. */
export function toSqlTime(t: Instant): string {
  const { date, clock } = fields(t);
  const micro = Math.floor(t.nanos / 1000);
  return `${date} ${clock}${micro > 0 ? `.${pad(micro, 6)}` : ""}`;
}

/** Go's RFC 3339 encoding of a UTC time: `Z`, and the shortest exact fraction. */
export function toRfc3339(t: Instant): string {
  const { date, clock } = fields(t);
  const fraction = pad(t.nanos, 9).replace(/0+$/, "");
  return `${date}T${clock}${fraction === "" ? "" : `.${fraction}`}Z`;
}

/** A TIMESTAMP(0) as MySQL returns it with `dateStrings` and a UTC session (`YYYY-MM-DD HH:MM:SS`), as Go writes it. */
export function fromSqlTime(text: string): string {
  const m = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)(?:\.0+)?$/.exec(text);
  if (m === null) throw new Error(`unexpected TIMESTAMP value ${JSON.stringify(text)}`);
  // eslint-disable-next-line @typescript-eslint/restrict-template-expressions -- groups 1 and 2 are not optional in the pattern, so both are defined after a match
  return `${m[1]}T${m[2]}Z`;
}
