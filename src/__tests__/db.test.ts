import { HistoryStore, INSERT_DELIVERY_SQL, INSERT_TRANSACTION_SQL, UPSERT_CONTRACT_SQL } from "../db/history";
import { COLUMN_TYPE_SQL, INDEX_EXISTS_SQL, migrate, SCHEMA } from "../db/migrate";
import { PING_ATTEMPTS, PING_DELAY_MS, setUpDatabase, waitForDatabase } from "../db/setup";
import { fromSqlTime, instantOfDate, instantOfTime, isZeroTime, toRfc3339, toSqlTime } from "../db/time";
import { UnencodableTime } from "../gateway/json";
import { FakeSql } from "../testSupport/fakeSql";

const flat = (s: string): string => s.replace(/\s+/g, " ").trim();

describe("the schema", () => {
  it("has the three tables, with money in BIGINT and the key columns Go has", () => {
    expect(SCHEMA).toHaveLength(3);
    const all = SCHEMA.map(flat).join("\n");
    expect(all).toContain("CREATE TABLE IF NOT EXISTS contracts ( id VARCHAR(64) PRIMARY KEY");
    expect(all).toContain("total_price BIGINT NOT NULL, agent_credits BIGINT NOT NULL, occurred_at TIMESTAMP NOT NULL");
    expect(all).toContain("units INT NOT NULL, delivered_at TIMESTAMP NOT NULL");
    expect(all).toContain("raw_json JSON NOT NULL");
  });
});

describe("migrate", () => {
  /** A database in the state `columns` and `indexes` describe. */
  const database = (types: Record<string, string | null>, existing: string[]) =>
    new FakeSql()
      .on(/information_schema\.COLUMNS/, (c) => {
        const type = types[`${String(c.params[0])}.${String(c.params[1])}`];
        return type === undefined || type === null ? [] : [[type]];
      })
      .on(/information_schema\.STATISTICS/, (c) => [[existing.includes(String(c.params[1])) ? "1" : "0"]]);

  it("on a fresh database: three tables, a catalogue lookup per money column, an index lookup and a CREATE INDEX each, in that order", async () => {
    const sql = database({ "transactions.total_price": "bigint", "transactions.agent_credits": "bigint" }, []);
    await migrate(sql, () => undefined);
    expect(sql.statements()).toEqual([
      ...SCHEMA.map(flat),
      flat(COLUMN_TYPE_SQL),
      flat(COLUMN_TYPE_SQL),
      flat(INDEX_EXISTS_SQL),
      "CREATE INDEX idx_deliveries_contract ON contract_deliveries (contract_id, delivered_at)",
      flat(INDEX_EXISTS_SQL),
      "CREATE INDEX idx_transactions_occurred ON transactions (occurred_at)",
      flat(INDEX_EXISTS_SQL),
      "CREATE INDEX idx_transactions_ship ON transactions (ship_symbol, occurred_at)",
    ]);
    expect(sql.calls.slice(3, 5).map((c) => c.params)).toEqual([
      ["transactions", "total_price"],
      ["transactions", "agent_credits"],
    ]);
    expect(sql.calls[5]?.params).toEqual(["contract_deliveries", "idx_deliveries_contract"]);
  });

  it("a database an earlier version made (INT money): both columns are widened, and before any index is built", async () => {
    const sql = database({ "transactions.total_price": "int", "transactions.agent_credits": "int" }, []);
    const log: string[] = [];
    await migrate(sql, (l) => log.push(l));
    const statements = sql.statements();
    expect(statements).toContain("ALTER TABLE transactions MODIFY total_price BIGINT NOT NULL");
    expect(statements).toContain("ALTER TABLE transactions MODIFY agent_credits BIGINT NOT NULL");
    const lastAlter = Math.max(...statements.map((s, i) => (s.startsWith("ALTER") ? i : -1)));
    const firstIndex = statements.findIndex((s) => s.startsWith("CREATE INDEX"));
    expect(lastAlter).toBeLessThan(firstIndex);
    expect(log).toEqual(["widening transactions.total_price from int to BIGINT NOT NULL", "widening transactions.agent_credits from int to BIGINT NOT NULL"]);
  });

  it("a BIGINT column, a column that is not there, and an index that is: nothing is altered or created", async () => {
    const sql = database({ "transactions.total_price": "bigint" }, ["idx_deliveries_contract", "idx_transactions_occurred", "idx_transactions_ship"]);
    await migrate(sql, () => undefined);
    expect(sql.statements().filter((s) => /^(ALTER|CREATE INDEX)/.test(s))).toEqual([]);
  });

  it("only the missing index is created", async () => {
    const sql = database({}, ["idx_deliveries_contract", "idx_transactions_ship"]);
    await migrate(sql, () => undefined);
    expect(sql.statements().filter((s) => s.startsWith("CREATE INDEX"))).toEqual(["CREATE INDEX idx_transactions_occurred ON transactions (occurred_at)"]);
  });

  it("reads the catalogue's text whatever it arrives as (bytes), and the count whatever it is (a BIGINT string)", async () => {
    const sql = new FakeSql()
      .on(/information_schema\.COLUMNS/, [[Buffer.from("int")]])
      .on(/information_schema\.STATISTICS/, [["2"]]);
    await migrate(sql, () => undefined);
    expect(sql.statements().filter((s) => s.startsWith("ALTER"))).toHaveLength(2);
    expect(sql.statements().filter((s) => s.startsWith("CREATE INDEX"))).toEqual([]);
  });

  it("stops at the first statement MySQL refuses", async () => {
    const sql = new FakeSql().on(/contract_deliveries/, new Error("boom"));
    await expect(migrate(sql, () => undefined)).rejects.toThrow("boom");
    expect(sql.calls).toHaveLength(2);
  });
});

describe("setUpDatabase", () => {
  const config = { host: "h", port: "3306", user: "u", password: "p", database: "d" };

  it("pings until MySQL answers (15 attempts at most, 2 s apart), then migrates, in that order", async () => {
    const sql = new FakeSql();
    sql.failPings = 3;
    const sleeps: number[] = [];
    const log: string[] = [];
    const out = await setUpDatabase(config, { open: () => sql, sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); }, log: (l) => log.push(l) });
    expect(out).toBe(sql);
    expect(sql.pings).toBe(4);
    expect(sleeps).toEqual([2000, 2000, 2000]);
    expect(log).toEqual([
      "Establishing connection to MySql DB...",
      "DB not ready yet (attempt 1/15): connection refused",
      "DB not ready yet (attempt 2/15): connection refused",
      "DB not ready yet (attempt 3/15): connection refused",
      "Connection to DB is established.",
      "Schema migrations applied.",
    ]);
    expect(sql.calls.length).toBeGreaterThan(3);
    expect(sql.closed).toBe(false);
  });

  it("gives up after 15 attempts with the last error, sleeping only between them, and closes the pool", async () => {
    expect([PING_ATTEMPTS, PING_DELAY_MS]).toEqual([15, 2000]);
    const sql = new FakeSql();
    sql.failPings = 100;
    const sleeps: number[] = [];
    await expect(setUpDatabase(config, { open: () => sql, sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); }, log: () => undefined })).rejects.toThrow("connection refused");
    expect(sql.pings).toBe(15);
    expect(sleeps).toHaveLength(14);
    expect(sql.calls).toEqual([]);
    expect(sql.closed).toBe(true);
  });

  it("a migration that fails closes the pool and fails the start", async () => {
    const sql = new FakeSql().on(/CREATE TABLE/, new Error("denied"));
    await expect(setUpDatabase(config, { open: () => sql, sleep: () => Promise.resolve(), log: () => undefined })).rejects.toThrow("denied");
    expect(sql.closed).toBe(true);
  });

  it("waitForDatabase succeeds on the last attempt", async () => {
    const sql = new FakeSql();
    sql.failPings = 14;
    await waitForDatabase(sql, () => undefined, () => Promise.resolve());
    expect(sql.pings).toBe(15);
  });
});

describe("times for MySQL", () => {
  it("are UTC text, microseconds truncated, and no fraction when there is none", () => {
    expect(toSqlTime({ seconds: 1772600767, nanos: 0 })).toBe("2026-03-04 05:06:07");
    expect(toSqlTime({ seconds: 1772600767, nanos: 123456789 })).toBe("2026-03-04 05:06:07.123456");
    expect(toSqlTime({ seconds: 1772600767, nanos: 999999999 })).toBe("2026-03-04 05:06:07.999999");
    expect(toSqlTime({ seconds: 1772600767, nanos: 1500 })).toBe("2026-03-04 05:06:07.000001");
    expect(toSqlTime({ seconds: 1772600767, nanos: 999 })).toBe("2026-03-04 05:06:07");
  });

  it("an offset is applied, not kept: the same instant in UTC", () => {
    expect(toSqlTime(instantOfTime("2026-03-04T07:06:07+02:00"))).toBe("2026-03-04 05:06:07");
    expect(toSqlTime(instantOfTime("2026-03-03T23:36:07-05:30"))).toBe("2026-03-04 05:06:07");
    expect(toSqlTime(instantOfTime("2026-03-04T05:06:07.6Z"))).toBe("2026-03-04 05:06:07.600000");
    // digits beyond the ninth are cut off, like Go
    expect(toSqlTime(instantOfTime("2026-03-04T05:06:07.1234567891Z"))).toBe("2026-03-04 05:06:07.123456");
  });

  it("an UnencodableTime (offset of a day or more) is still an instant", () => {
    expect(toSqlTime(instantOfTime(new UnencodableTime("2026-03-04T05:06:07+24:00")))).toBe("2026-03-03 05:06:07");
  });

  it("the zero time is 0001-01-01T00:00:00Z whatever zone it is written in, and nothing else is", () => {
    expect(isZeroTime(instantOfTime("0001-01-01T00:00:00Z"))).toBe(true);
    expect(isZeroTime(instantOfTime("0001-01-01T01:00:00+01:00"))).toBe(true);
    expect(isZeroTime(instantOfTime("0001-01-01T00:00:00.000000001Z"))).toBe(false);
    expect(isZeroTime(instantOfTime("0001-01-01T00:00:01Z"))).toBe(false);
    expect(isZeroTime(instantOfTime("2026-03-04T05:06:07Z"))).toBe(false);
  });

  it("a year outside 1..9999 is refused, like the driver refuses it", () => {
    expect(() => toSqlTime(instantOfTime("0001-01-01T00:00:00+01:00"))).toThrow(/year must be in range/);
    expect(toSqlTime(instantOfTime("0001-01-01T00:00:01Z"))).toBe("0001-01-01 00:00:01");
    expect(toSqlTime(instantOfTime("9999-12-31T23:59:59Z"))).toBe("9999-12-31 23:59:59");
  });

  it("an offset that carries the year past 9999 is refused too", () => {
    expect(() => toSqlTime(instantOfTime("9999-12-31T23:59:59-01:00"))).toThrow(/year must be in range/);
    expect(toSqlTime(instantOfTime("9999-12-31T23:59:59+00:00"))).toBe("9999-12-31 23:59:59");
  });

  it("years below 100 are years, not 19xx", () => {
    expect(toSqlTime(instantOfTime("0050-06-01T00:00:00Z"))).toBe("0050-06-01 00:00:00");
  });

  it("an instant from a Date keeps the milliseconds as nanoseconds", () => {
    expect(instantOfDate(new Date("2026-03-04T05:06:07.123Z"))).toEqual({ seconds: 1772600767, nanos: 123000000 });
    expect(instantOfDate(new Date("1969-12-31T23:59:59.500Z"))).toEqual({ seconds: -1, nanos: 500000000 });
  });

  it("RFC 3339 output is Go's: Z, the shortest exact fraction", () => {
    expect(toRfc3339({ seconds: 1772600767, nanos: 0 })).toBe("2026-03-04T05:06:07Z");
    expect(toRfc3339({ seconds: 1772600767, nanos: 120000000 })).toBe("2026-03-04T05:06:07.12Z");
    expect(toRfc3339({ seconds: 1772600767, nanos: 123456789 })).toBe("2026-03-04T05:06:07.123456789Z");
    expect(toRfc3339({ seconds: 1772600767, nanos: 1 })).toBe("2026-03-04T05:06:07.000000001Z");
  });

  it("a TIMESTAMP comes back as RFC 3339 UTC, whole seconds", () => {
    expect(fromSqlTime("2026-03-04 05:06:07")).toBe("2026-03-04T05:06:07Z");
    expect(fromSqlTime("2026-03-04 05:06:07.000000")).toBe("2026-03-04T05:06:07Z");
    expect(() => fromSqlTime("0000-00-00 00:00:00x")).toThrow();
  });
});

describe("the history store's SQL", () => {
  const tx = {
    type: "SELL" as const,
    shipSymbol: "SHIP-1",
    waypointSymbol: "X1-A",
    shipType: null,
    tradeSymbol: "IRON",
    units: 2n,
    pricePerUnit: 3n,
    totalPrice: 9007199254740993n,
    agentCredits: -10n,
    occurredAt: "2026-03-04 05:06:07",
  };

  it("inserts a transaction with ten placeholders in the column order, int64 as exact decimal text", async () => {
    const sql = new FakeSql();
    await new HistoryStore(sql).insertTransaction(tx);
    expect(flat(sql.calls[0]?.sql ?? "")).toBe(
      "INSERT INTO transactions (type, ship_symbol, waypoint_symbol, ship_type, trade_symbol, units, price_per_unit, total_price, agent_credits, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    expect(sql.calls[0]?.sql).toBe(INSERT_TRANSACTION_SQL);
    expect(sql.calls[0]?.params).toEqual(["SELL", "SHIP-1", "X1-A", null, "IRON", "2", "3", "9007199254740993", "-10", "2026-03-04 05:06:07"]);
  });

  it("a ship purchase's cargo members are NULL, an empty ship type is not", async () => {
    const sql = new FakeSql();
    await new HistoryStore(sql).insertTransaction({ ...tx, type: "SHIP_PURCHASE", shipType: "", tradeSymbol: null, units: null, pricePerUnit: null });
    expect(sql.calls[0]?.params.slice(3, 7)).toEqual(["", null, null, null]);
  });

  it("upserts a contract on its id, updating only the state", async () => {
    const sql = new FakeSql();
    await new HistoryStore(sql).upsertContract({ id: "C", factionSymbol: "F", type: "PROCUREMENT", accepted: true, fulfilled: false, rawJson: "{}", updatedAt: "2026-03-04 05:06:07" });
    expect(flat(UPSERT_CONTRACT_SQL)).toBe(
      "INSERT INTO contracts (id, faction_symbol, type, accepted, fulfilled, raw_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE accepted = VALUES(accepted), fulfilled = VALUES(fulfilled), raw_json = VALUES(raw_json), updated_at = VALUES(updated_at)",
    );
    expect(sql.calls[0]?.params).toEqual(["C", "F", "PROCUREMENT", 1, 0, "{}", "2026-03-04 05:06:07"]);
    await new HistoryStore(sql).upsertContract({ id: "C", factionSymbol: "F", type: "T", accepted: false, fulfilled: true, rawJson: "{}", updatedAt: "x" });
    expect(sql.calls[1]?.params.slice(3, 5)).toEqual([0, 1]);
  });

  it("inserts a delivery, units as decimal text", async () => {
    const sql = new FakeSql();
    await new HistoryStore(sql).insertDelivery({ contractId: "C", shipSymbol: "S", tradeSymbol: "T", units: 2147483648n, deliveredAt: "2026-03-04 05:06:07.123000" });
    expect(flat(INSERT_DELIVERY_SQL)).toBe("INSERT INTO contract_deliveries (contract_id, ship_symbol, trade_symbol, units, delivered_at) VALUES (?, ?, ?, ?, ?)");
    expect(sql.calls[0]?.params).toEqual(["C", "S", "T", "2147483648", "2026-03-04 05:06:07.123000"]);
  });

  it("lists deliveries oldest first, filtered by the contract in SQL", async () => {
    const sql = new FakeSql().on(/contract_deliveries/, [
      ["C", "S", "T", 3, "2026-03-04 05:06:07"],
      ["C", "S2", "T2", 4, "2026-03-04 05:06:08"],
    ]);
    const rows = await new HistoryStore(sql).deliveriesForContract("C");
    expect(flat(sql.calls[0]?.sql ?? "")).toBe("SELECT contract_id, ship_symbol, trade_symbol, units, delivered_at FROM contract_deliveries WHERE contract_id = ? ORDER BY delivered_at ASC");
    expect(sql.calls[0]?.params).toEqual(["C"]);
    expect(rows).toEqual([
      { contractId: "C", shipSymbol: "S", tradeSymbol: "T", units: 3n, deliveredAt: "2026-03-04T05:06:07Z" },
      { contractId: "C", shipSymbol: "S2", tradeSymbol: "T2", units: 4n, deliveredAt: "2026-03-04T05:06:08Z" },
    ]);
    expect(Object.keys(rows[0] ?? {})).toEqual(["contractId", "shipSymbol", "tradeSymbol", "units", "deliveredAt"]);
  });

  it("no deliveries is an empty list", async () => {
    expect(await new HistoryStore(new FakeSql()).deliveriesForContract("C")).toEqual([]);
  });

  describe("listing transactions", () => {
    const base = "SELECT type, ship_symbol, waypoint_symbol, ship_type, trade_symbol, units, price_per_unit, total_price, agent_credits, occurred_at FROM transactions";
    const list = async (q: Parameters<HistoryStore["listTransactions"]>[0]) => {
      const sql = new FakeSql();
      await new HistoryStore(sql).listTransactions(q);
      return { statement: flat(sql.calls[0]?.sql ?? ""), params: sql.calls[0]?.params };
    };

    it("no filter: newest first, and the limit as text (the binary protocol sends a number as a double, which LIMIT refuses)", async () => {
      expect(await list({ shipSymbol: "", type: null, limit: 100 })).toEqual({ statement: `${base} ORDER BY occurred_at DESC LIMIT ?`, params: ["100"] });
    });

    it("by ship", async () => {
      expect(await list({ shipSymbol: "S", type: null, limit: 5 })).toEqual({ statement: `${base} WHERE ship_symbol = ? ORDER BY occurred_at DESC LIMIT ?`, params: ["S", "5"] });
    });

    it("by type", async () => {
      expect(await list({ shipSymbol: "", type: "SELL", limit: 1000 })).toEqual({ statement: `${base} WHERE type = ? ORDER BY occurred_at DESC LIMIT ?`, params: ["SELL", "1000"] });
    });

    it("by ship and type, in that order", async () => {
      expect(await list({ shipSymbol: "S", type: "PURCHASE", limit: 7 })).toEqual({
        statement: `${base} WHERE ship_symbol = ? AND type = ? ORDER BY occurred_at DESC LIMIT ?`,
        params: ["S", "PURCHASE", "7"],
      });
    });

    it("a ship symbol that is bytes, not text, goes through as bytes", async () => {
      const bytes = Buffer.from([0xff]);
      expect((await list({ shipSymbol: bytes, type: null, limit: 1 })).params?.[0]).toBe(bytes);
      expect((await list({ shipSymbol: Buffer.alloc(0), type: null, limit: 1 })).statement).not.toContain("WHERE");
    });

    it("rows come back as the API shows them: NULL members are absent, empty and zero ones are not, BIGINT is exact", async () => {
      const sql = new FakeSql().on(/FROM transactions/, [
        ["SELL", "S", "W", null, "T", 0, 0, "9007199254740993", "-5", "2026-03-04 05:06:07"],
        ["SHIP_PURCHASE", "S2", "W2", "SHIP_PROBE", null, null, null, "55000", "120000", "2026-03-04 05:06:08"],
        ["SHIP_PURCHASE", "", "", "", null, null, null, "0", "0", "2026-03-04 05:06:09"],
      ]);
      const rows = await new HistoryStore(sql).listTransactions({ shipSymbol: "", type: null, limit: 10 });
      expect(rows).toEqual([
        { type: "SELL", shipSymbol: "S", waypointSymbol: "W", tradeSymbol: "T", units: 0n, pricePerUnit: 0n, totalPrice: 9007199254740993n, agentCredits: -5n, occurredAt: "2026-03-04T05:06:07Z" },
        { type: "SHIP_PURCHASE", shipSymbol: "S2", waypointSymbol: "W2", shipType: "SHIP_PROBE", totalPrice: 55000n, agentCredits: 120000n, occurredAt: "2026-03-04T05:06:08Z" },
        { type: "SHIP_PURCHASE", shipSymbol: "", waypointSymbol: "", shipType: "", totalPrice: 0n, agentCredits: 0n, occurredAt: "2026-03-04T05:06:09Z" },
      ]);
      expect(Object.keys(rows[0] ?? {})).toEqual(["type", "shipSymbol", "waypointSymbol", "tradeSymbol", "units", "pricePerUnit", "totalPrice", "agentCredits", "occurredAt"]);
      expect(Object.keys(rows[1] ?? {})).toEqual(["type", "shipSymbol", "waypointSymbol", "shipType", "totalPrice", "agentCredits", "occurredAt"]);
    });
  });
});
