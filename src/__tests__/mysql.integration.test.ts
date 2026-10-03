import { HistoryStore } from "../db/history";
import { setUpDatabase } from "../db/setup";
import { MysqlSql } from "../db/sql";

// Against a real MySQL, when TEST_MYSQL_HOST is set (the `test` job of container.yml has one; locally: any MySQL 9 with the
// root password `example`). The server's own time zone is moved away from UTC first, so that a session that is not
// pinned to UTC shows in behaviour and not only in the text of a statement.
const host = process.env["TEST_MYSQL_HOST"];
const config = {
  host: host ?? "",
  port: process.env["TEST_MYSQL_PORT"] ?? "3306",
  user: "root",
  password: process.env["TEST_MYSQL_PASSWORD"] ?? "example",
  database: process.env["TEST_MYSQL_DATABASE"] ?? "vnm-agent-db",
};

(host === undefined ? describe.skip : describe)("against a real MySQL, whose global time zone is not UTC", () => {
  let admin: MysqlSql;
  let previous = "SYSTEM";

  beforeAll(async () => {
    admin = new MysqlSql(config);
    previous = String((await admin.execute("SELECT @@global.time_zone"))[0]?.[0]);
    await admin.execute("SET GLOBAL time_zone = '+05:00'");
  });
  afterAll(async () => {
    await admin.execute(`SET GLOBAL time_zone = '${previous}'`);
    await admin.close();
  });

  it("every session is UTC, and a time is stored and read back as the same UTC instant, rounded to the second", async () => {
    const sql = await setUpDatabase(config, { log: () => undefined });
    try {
      expect((await sql.execute("SELECT @@session.time_zone, @@global.time_zone"))[0]).toEqual(["+00:00", "+05:00"]);
      const ship = `TZ-${Date.now()}`;
      await new HistoryStore(sql).insertTransaction({
        type: "SELL", shipSymbol: ship, waypointSymbol: "W", shipType: null, tradeSymbol: "T", units: 1n, pricePerUnit: 1n,
        totalPrice: 9007199254740993n, agentCredits: 1n, occurredAt: "2026-03-04 05:06:07.600000",
      });
      // The instant itself, which a session in +05:00 would have shifted by five hours.
      expect((await sql.execute("SELECT UNIX_TIMESTAMP(occurred_at) FROM transactions WHERE ship_symbol = ?", [ship]))[0]?.[0]).toBe("1772600768");
      expect(await new HistoryStore(sql).listTransactions({ shipSymbol: ship.toLowerCase(), type: null, limit: 5 })).toEqual([
        expect.objectContaining({ occurredAt: "2026-03-04T05:06:08Z", totalPrice: 9007199254740993n, shipSymbol: ship }),
      ]);
    } finally {
      await sql.close();
    }
  });

  it("a connection kept for the whole pool is still UTC (the setting is per connection, not per pool)", async () => {
    const sql = new MysqlSql(config);
    try {
      const zones = await Promise.all(Array.from({ length: 10 }, () => sql.execute("SELECT SLEEP(0.2), @@session.time_zone")));
      expect(zones.map((z) => z[0]?.[1])).toEqual(Array(10).fill("+00:00"));
    } finally {
      await sql.close();
    }
  });
});
