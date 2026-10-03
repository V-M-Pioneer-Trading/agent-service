import { hasUnencodable, UnencodableTime } from "../gateway/json";
import { getMyContractResponse, getMyShipResponse, getMyShipsResponse } from "../gateway/schema";
import { bool, DecodeError, decode, foldName, int64, list, normaliseTime, struct, text, time, ZERO_TIME, type Schema } from "../gateway/decode";

const decodeAs = <S extends Schema>(schema: S, body: string) => decode(schema, Buffer.from(body));
const dec = <S extends Schema>(schema: S, body: string) => decode(schema, Buffer.from(body));

const inner = struct({ n: int64, s: text });
const thing = struct({ id: text, count: int64, ok: bool, at: time, items: list(inner), sub: inner });

describe("zero values and absent members", () => {
  const zero = { id: "", count: 0n, ok: false, at: ZERO_TIME, items: null, sub: { n: 0n, s: "" } };
  it.each(["", "null", "{}", '{"unknown":[1,{"deep":null}]}'])("%j is the zero value", (body) => {
    expect(dec(thing, body)).toEqual(zero);
  });
  it("null members change nothing", () => {
    expect(dec(thing, '{"id":null,"count":null,"ok":null,"at":null,"items":null,"sub":null}')).toEqual(zero);
    expect(dec(thing, '{"id":"a","id":null}').id).toBe("a");
  });
  it("an empty list stays empty, a null element is a zero element", () => {
    expect(dec(thing, '{"items":[]}').items).toEqual([]);
    expect(dec(thing, '{"items":[null,{}]}').items).toEqual([zero.sub, zero.sub]);
  });
  it("a body of only whitespace is an error, not a zero value", () => {
    expect(() => dec(thing, "  \n")).toThrow(DecodeError);
  });
  it("members come out in schema order", () => {
    expect(Object.keys(dec(thing, '{"sub":{"s":"x"},"id":"i"}'))).toEqual(["id", "count", "ok", "at", "items", "sub"]);
  });
});

describe("null resets a list, and only a list", () => {
  it("sets an earlier list back to null, at every depth", () => {
    expect(dec(thing, '{"items":[{"n":1}],"items":null}').items).toBeNull();
    expect(dec(thing, '{"items":[],"ITEMS":null}').items).toBeNull();
    expect(dec(thing, '{"items":null,"items":[{"n":2}]}').items).toEqual([{ n: 2n, s: "" }]);
    expect(dec(thing, '{"sub":{"n":4},"sub":null,"id":"a","id":null,"count":5,"count":null}')).toMatchObject({ sub: { n: 4n }, id: "a", count: 5n });
  });
  it("applies to data, cargo.inventory, modules, mounts, deposits and terms.deliver", () => {
    const ship = decodeAs(getMyShipsResponse, '{"data":[{"modules":[{}],"modules":null,"mounts":[{"deposits":["x"],"deposits":null}],"cargo":{"inventory":[{}],"inventory":null}}],"data":null}');
    expect(ship.data).toBeNull();
    const one = decodeAs(getMyShipResponse, '{"data":{"modules":[{}],"modules":null,"mounts":[{"deposits":["x"],"deposits":null}],"mounts":[{"deposits":["x"],"deposits":null}],"cargo":{"inventory":[{}],"inventory":null}}}').data;
    expect(one.modules).toBeNull();
    expect(one.cargo.inventory).toBeNull();
    expect(one.mounts?.[0]?.deposits).toBeNull();
    const contract = decodeAs(getMyContractResponse, '{"data":{"terms":{"deliver":[{}],"deliver":null}}}').data;
    expect(contract.terms.deliver).toBeNull();
  });
});

describe("member names", () => {
  it("match case-insensitively but not across punctuation", () => {
    expect(dec(inner, '{"N":5,"S":"x"}')).toEqual({ n: 5n, s: "x" });
    expect(dec(struct({ startingFaction: text }), '{"starting_faction":"F","STARTINGFACTION":"G"}')).toEqual({ startingFaction: "G" });
  });
  it("fold like Go's bytes.EqualFold: long s, Kelvin sign, final sigma, but not dotless i or sharp s", () => {
    expect(foldName("ſymbol")).toBe(foldName("symbol"));
    expect(foldName("Key")).toBe(foldName("key"));
    expect(foldName("ς")).toBe(foldName("σ"));
    expect(foldName("ẞ")).toBe(foldName("ß"));
    expect(foldName("ß")).not.toBe(foldName("ss"));
    expect(foldName("ı")).not.toBe(foldName("i"));
    expect(foldName("İ")).not.toBe(foldName("i"));
    expect(dec(struct({ symbol: text }), '{"ſYMBOL":"bound"}')).toEqual({ symbol: "bound" });
    expect(dec(struct({ symbol: text }), '{"ıymbol":"no"}')).toEqual({ symbol: "" });
  });
  it("the last repeat wins; objects and arrays merge into the earlier one, like Go", () => {
    expect(dec(thing, '{"id":"a","ID":"b","id":"c"}').id).toBe("c");
    expect(dec(thing, '{"sub":{"n":1,"s":"keep"},"sub":{"n":2}}').sub).toEqual({ n: 2n, s: "keep" });
    expect(dec(thing, '{"items":[{"n":1,"s":"a"},{"n":2}],"items":[{"n":9}]}').items).toEqual([{ n: 9n, s: "a" }]);
  });
});

describe("integers are int64", () => {
  it("survive exactly, at the edges and beyond 2^53", () => {
    expect(dec(thing, '{"count":9007199254740993}').count).toBe(9007199254740993n);
    expect(dec(thing, '{"count":9223372036854775807}').count).toBe(9223372036854775807n);
    expect(dec(thing, '{"count":-9223372036854775808}').count).toBe(-9223372036854775808n);
    expect(dec(thing, '{"count":-0}').count).toBe(0n);
  });
  it.each(["1.5", "5.0", "1e3", "1E3", "9223372036854775808", "-9223372036854775809", '"5"', "true", "{}", "[]"])("%s is not an int64", (v) => {
    expect(() => dec(thing, `{"count":${v}}`)).toThrow(DecodeError);
  });
});

describe("types do not coerce", () => {
  it.each([
    ['{"id":5}'],
    ['{"id":true}'],
    ['{"id":{}}'],
    ['{"ok":"true"}'],
    ['{"ok":1}'],
    ['{"items":{}}'],
    ['{"items":[1]}'],
    ['{"sub":[]}'],
    ['{"sub":"x"}'],
    ['{"at":5}'],
    ["[]"],
    ['"text"'],
    ["7"],
    ["true"],
    ['{"id":"x"} trailing'],
    ['{"id":"x"}{}'],
  ])("%s is an error", (body) => {
    expect(() => dec(thing, body)).toThrow(DecodeError);
  });
});

describe("times", () => {
  it.each([
    ["2026-01-02T03:04:05Z", "2026-01-02T03:04:05Z"],
    ["2026-01-02T03:04:05.000Z", "2026-01-02T03:04:05Z"],
    ["2026-01-02T03:04:05.100Z", "2026-01-02T03:04:05.1Z"],
    ["2026-01-02T03:04:05.120Z", "2026-01-02T03:04:05.12Z"],
    ["2026-01-02T03:04:05.123456789Z", "2026-01-02T03:04:05.123456789Z"],
    ["2026-01-02T03:04:05.9999999999Z", "2026-01-02T03:04:05.999999999Z"],
    ["2026-01-02T03:04:05.1000000009Z", "2026-01-02T03:04:05.1Z"],
    ["2026-01-02T03:04:05+00:00", "2026-01-02T03:04:05Z"],
    ["2026-01-02T03:04:05-00:00", "2026-01-02T03:04:05Z"],
    ["2026-01-02T03:04:05+02:00", "2026-01-02T03:04:05+02:00"],
    ["2026-01-02T03:04:05.500-05:30", "2026-01-02T03:04:05.5-05:30"],
    ["2026-01-02T03:04:05+00:30", "2026-01-02T03:04:05+00:30"],
    ["2026-01-02T03:04:05-00:45", "2026-01-02T03:04:05-00:45"],
    ["2026-01-02T3:04:05Z", "2026-01-02T03:04:05Z"],
    ["2026-01-02T03:04:05,5Z", "2026-01-02T03:04:05.5Z"],
    ["2026-01-02T03:04:05+00:60", "2026-01-02T03:04:05+01:00"],
    ["2026-01-02T03:04:05-00:60", "2026-01-02T03:04:05-01:00"],
    ["2026-01-02T03:04:05+02:60", "2026-01-02T03:04:05+03:00"],
    ["2026-01-02T03:04:05+23:59", "2026-01-02T03:04:05+23:59"],
    ["2026-01-02T03:04:05+00:00", "2026-01-02T03:04:05Z"],
    ["2024-02-29T00:00:00Z", "2024-02-29T00:00:00Z"],
    ["0000-01-01T00:00:00Z", "0000-01-01T00:00:00Z"],
    ["9999-12-31T23:59:59Z", "9999-12-31T23:59:59Z"],
  ])("%s is written back as %s", (sent, back) => {
    expect(normaliseTime(sent)).toBe(back);
    expect(dec(thing, JSON.stringify({ at: sent })).at).toBe(back);
  });

  it.each([
    "2026-01-02 03:04:05Z", "2026-01-02t03:04:05z", "2026-01-02T03:04:05", "2026-01-02", "", " 2026-01-02T03:04:05Z", "2026-01-02T03:04:05Z ",
    "2026-12-31T23:59:60Z", "2026-13-02T03:04:05Z", "2026-00-02T03:04:05Z", "2026-02-30T03:04:05Z", "2025-02-29T00:00:00Z", "1900-02-29T00:00:00Z", "2026-01-00T03:04:05Z",
    "2026-01-02T24:04:05Z", "2026-01-02T03:60:05Z", "2026-01-02T03:04:05+0200", "2026-01-02T03:04:05+25:00", "2026-01-02T03:04:05+24:61", "2026-01-02T03:04:05+02:61",
    "2026-01-02T123:04:05Z", "2026-01-02T03:04:05,Z", "2026-01-02T03:04:05.Z", "2026-1-2T3:4:5Z", "2026-01-02T03:04:05١Z",
  ])("%j is not a time", (sent) => {
    expect(() => dec(thing, JSON.stringify({ at: sent }))).toThrow(DecodeError);
  });

  it.each(["+24:00", "-24:00", "+23:60", "+24:05", "-24:60"])("a zone offset of %s is read, and cannot be written", (zone) => {
    expect(normaliseTime(`2026-01-02T03:04:05${zone}`)).toBeInstanceOf(UnencodableTime);
    expect(hasUnencodable(dec(thing, JSON.stringify({ at: `2026-01-02T03:04:05${zone}` })))).toBe(true);
  });

  it("is judged on the source text: an escape can never be a time", () => {
    expect(() => dec(thing, '{"at":"2026-01-02T03:04:05\\u005a"}')).toThrow(DecodeError);
    expect(() => dec(thing, '{"at":"2026-01-02T03:04:05Z"}')).not.toThrow();
  });
});
