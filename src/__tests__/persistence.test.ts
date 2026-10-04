import { decode } from "../gateway/decode";
import { UnencodableTime } from "../gateway/json";
import { contractAndAgentSchema, marketTransactionResultSchema, purchaseShipResultSchema } from "../gateway/schema";
import { HistoryStore } from "../db/history";
import { persistCargoTrade, persistContract, persistShipPurchase, symbolColumn, textOrBytes, utf8 } from "../persistence";
import { FakeSql } from "../testSupport/fakeSql";

const NOW = new Date("2026-05-06T07:08:09.250Z");
const now = () => NOW;
const body = (o: unknown) => Buffer.from(JSON.stringify(o));
const market = (tx: Record<string, unknown> = {}, agent: Record<string, unknown> = { credits: 175100 }) =>
  decode(
    marketTransactionResultSchema,
    body({
      agent,
      cargo: { capacity: 10, units: 1, inventory: [] },
      transaction: { waypointSymbol: "X1-A", shipSymbol: "FROM-ANSWER", tradeSymbol: "IRON", type: "SELL", units: 4, pricePerUnit: 25, totalPrice: 100, timestamp: "2026-03-04T05:06:07Z", ...tx },
    }),
  );
const ship = (tx: Record<string, unknown> = {}) =>
  decode(purchaseShipResultSchema, body({ agent: { credits: 120000 }, ship: { symbol: "NEW-1" }, transaction: { waypointSymbol: "X1-C", shipType: "SHIP_PROBE", price: 55000, agentSymbol: "A", timestamp: "2026-03-04T05:06:07Z", ...tx } }));

function setup(fail?: Error) {
  const sql = new FakeSql();
  if (fail !== undefined) sql.on(/INSERT/, fail);
  const log: string[] = [];
  return { sql, store: new HistoryStore(sql), log, logger: (l: string) => void log.push(l) };
}

describe("persistCargoTrade", () => {
  it("takes the ship from the path and everything else from the answer", async () => {
    const { sql, store, logger } = setup();
    await persistCargoTrade(store, "SELL", Buffer.from("PATH-SHIP"), market(), logger, now);
    expect(sql.calls).toHaveLength(1);
    expect(sql.calls[0]?.params).toEqual(["SELL", "PATH-SHIP", "X1-A", null, "IRON", "4", "25", "100", "175100", "2026-03-04 05:06:07"]);
  });

  it("PURCHASE is a type of its own", async () => {
    const { sql, store, logger } = setup();
    await persistCargoTrade(store, "PURCHASE", Buffer.from("S"), market(), logger, now);
    expect(sql.calls[0]?.params[0]).toBe("PURCHASE");
  });

  it("an empty answer is a zero row: empty strings, zero numbers, the time of the request", async () => {
    const { sql, store, logger } = setup();
    await persistCargoTrade(store, "SELL", Buffer.from("S"), decode(marketTransactionResultSchema, new Uint8Array()), logger, now);
    expect(sql.calls[0]?.params).toEqual(["SELL", "S", "", null, "", "0", "0", "0", "0", "2026-05-06 07:08:09.250000"]);
  });

  it("the gateway's time is kept, as the same instant in UTC; a zero or missing one is now", async () => {
    const stamp = async (timestamp: unknown) => {
      const { sql, store, logger } = setup();
      await persistCargoTrade(store, "SELL", Buffer.from("S"), market(timestamp === undefined ? { timestamp: undefined } : { timestamp }), logger, now);
      return sql.calls[0]?.params[9];
    };
    expect(await stamp("2026-03-04T07:06:07+02:00")).toBe("2026-03-04 05:06:07");
    expect(await stamp("2026-03-04T05:06:07.6Z")).toBe("2026-03-04 05:06:07.600000");
    expect(await stamp("0001-01-01T00:00:00Z")).toBe("2026-05-06 07:08:09.250000");
    expect(await stamp(null)).toBe("2026-05-06 07:08:09.250000");
    expect(await stamp(undefined)).toBe("2026-05-06 07:08:09.250000");
    expect(await stamp("0001-01-01T05:30:00+05:30")).toBe("2026-05-06 07:08:09.250000");
  });

  it("a time Go reads but cannot write (an offset of a day or more) is still recorded", async () => {
    const { sql, store, logger } = setup();
    const result = market({ timestamp: "2026-03-04T05:06:07+24:00" });
    expect(result.transaction.timestamp).toBeInstanceOf(UnencodableTime);
    await persistCargoTrade(store, "SELL", Buffer.from("S"), result, logger, now);
    expect(sql.calls[0]?.params[9]).toBe("2026-03-03 05:06:07");
  });

  it("int64 money beyond 2^53 reaches the statement exactly", async () => {
    const { sql, store, logger } = setup();
    const result = decode(
      marketTransactionResultSchema,
      Buffer.from('{"agent":{"credits":9007199254740993},"transaction":{"totalPrice":9007199254740995,"units":3000000000,"timestamp":"2026-03-04T05:06:07Z"}}'),
    );
    await persistCargoTrade(store, "SELL", Buffer.from("S"), result, logger, now);
    expect(sql.calls[0]?.params.slice(5, 9)).toEqual(["3000000000", "0", "9007199254740995", "9007199254740993"]);
  });

  it("a failed insert is logged, never thrown, with the type and the ship", async () => {
    const { store, log, logger } = setup(new Error("Data too long for column 'ship_symbol' at row 1"));
    await expect(persistCargoTrade(store, "SELL", Buffer.from("SHIP-X"), market(), logger, now)).resolves.toBeUndefined();
    expect(log).toEqual(["failed to persist SELL transaction for SHIP-X: Data too long for column 'ship_symbol' at row 1"]);
  });

  it("a ship symbol that is not UTF-8 is a refusal like MySQL's: logged, nothing inserted", async () => {
    const { sql, store, log, logger } = setup();
    await persistCargoTrade(store, "SELL", Buffer.from([0x53, 0xff]), market(), logger, now);
    expect(sql.calls).toEqual([]);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatch(/^failed to persist SELL transaction for S.*: Incorrect string value/);
  });

  it("a time that cannot be stored (year 0) is logged, not thrown", async () => {
    const { sql, store, log, logger } = setup();
    await persistCargoTrade(store, "SELL", Buffer.from("S"), market({ timestamp: "0001-01-01T00:00:00+01:00" }), logger, now);
    expect(sql.calls).toEqual([]);
    expect(log[0]).toMatch(/year must be in range/);
  });
});

describe("persistShipPurchase", () => {
  it("takes the ship from the answer, and records the ship type (even an empty one) but no cargo members", async () => {
    const { sql, store, logger } = setup();
    await persistShipPurchase(store, ship(), logger, now);
    expect(sql.calls[0]?.params).toEqual(["SHIP_PURCHASE", "NEW-1", "X1-C", "SHIP_PROBE", null, null, null, "55000", "120000", "2026-03-04 05:06:07"]);
    const empty = setup();
    await persistShipPurchase(empty.store, decode(purchaseShipResultSchema, new Uint8Array()), empty.logger, now);
    expect(empty.sql.calls[0]?.params).toEqual(["SHIP_PURCHASE", "", "", "", null, null, null, "0", "0", "2026-05-06 07:08:09.250000"]);
  });

  it("a failed insert is logged with the ship of the answer", async () => {
    const { store, log, logger } = setup(new Error("boom"));
    await persistShipPurchase(store, ship(), logger, now);
    expect(log).toEqual(["failed to persist SHIP_PURCHASE transaction for NEW-1: boom"]);
  });
});

describe("persistContract", () => {
  const contract = (extra: Record<string, unknown> = {}) =>
    decode(
      contractAndAgentSchema,
      body({ agent: {}, contract: { id: "C-1", factionSymbol: "COSMIC", type: "PROCUREMENT", accepted: true, fulfilled: false, terms: { deadline: "2026-03-04T05:06:07Z", payment: { onAccepted: 1, onFulfilled: 2 }, deliver: [] }, expiration: "2026-03-04T05:06:07Z", deadlineToAccept: "2026-03-04T05:06:07Z", ...extra } }),
    ).contract;

  it("upserts the contract with its flags and the whole contract as JSON, stamped now", async () => {
    const { sql, store, logger } = setup();
    await persistContract(store, contract(), logger, now);
    const [params] = [sql.calls[0]?.params ?? []];
    expect(params.slice(0, 5)).toEqual(["C-1", "COSMIC", "PROCUREMENT", 1, 0]);
    expect(JSON.parse(String(params[5]))).toEqual({
      id: "C-1",
      factionSymbol: "COSMIC",
      type: "PROCUREMENT",
      terms: { deadline: "2026-03-04T05:06:07Z", payment: { onAccepted: 1, onFulfilled: 2 }, deliver: [] },
      accepted: true,
      fulfilled: false,
      expiration: "2026-03-04T05:06:07Z",
      deadlineToAccept: "2026-03-04T05:06:07Z",
    });
    expect(params[6]).toBe("2026-05-06 07:08:09.250000");
  });

  it("a failed write is logged and not thrown", async () => {
    const { store, log, logger } = setup(new Error("Data too long"));
    await persistContract(store, contract(), logger, now);
    expect(log).toEqual(["failed to persist contract C-1: Data too long"]);
  });

  it("a contract Go cannot marshal (a time with an offset of a day or more) is logged and not written", async () => {
    const { sql, store, log, logger } = setup();
    await persistContract(store, contract({ expiration: "2026-03-04T05:06:07+24:00" }), logger, now);
    expect(sql.calls).toEqual([]);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatch(/^failed to marshal contract C-1 for persistence: /);
  });

  it("an empty answer is the zero contract: an empty id, the zero time", async () => {
    const { sql, store, logger } = setup();
    await persistContract(store, decode(contractAndAgentSchema, new Uint8Array()).contract, logger, now);
    expect(sql.calls[0]?.params.slice(0, 5)).toEqual(["", "", "", 0, 0]);
    expect(String(sql.calls[0]?.params[5])).toContain('"expiration":"0001-01-01T00:00:00Z"');
    expect(String(sql.calls[0]?.params[5])).toContain('"deliver":null');
  });
});

describe("UTF-8 symbols", () => {
  it("bytes that are UTF-8 are text, anything else is not", () => {
    expect(utf8(Buffer.from("héllo😀"))).toBe("héllo😀");
    expect(utf8(Buffer.alloc(0))).toBe("");
    for (const bad of [[0xff], [0xc3], [0xc0, 0x80], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0x61, 0xe2, 0x82]]) {
      expect(utf8(Buffer.from(bad))).toBeNull();
    }
    expect(() => symbolColumn(Buffer.from([0xff]))).toThrow(/Incorrect string value/);
    expect(symbolColumn(Buffer.from("ok"))).toBe("ok");
  });

  it("a query parameter keeps bytes that are not text, as bytes", () => {
    expect(textOrBytes(Buffer.from("é"))).toBe("é");
    const raw = Buffer.from([0xff]);
    expect(textOrBytes(raw)).toEqual(raw);
    expect(typeof textOrBytes(raw)).toBe("object");
  });
});
