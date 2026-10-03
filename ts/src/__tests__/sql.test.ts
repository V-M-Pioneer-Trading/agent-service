import { CONN_MAX_LIFETIME_MS, MAX_OPEN_CONNS, MysqlSql, poolOptions } from "../db/sql";

// mysql2 is replaced by a pool that hands out scripted connections: what is under test is the
// options we ask for, the session setup, and the lifetime rule, not the driver.
interface FakeCore {
  query: jest.Mock;
  destroy: jest.Mock;
}
interface FakeConn {
  connection: FakeCore;
  execute: jest.Mock;
  ping: jest.Mock;
  release: jest.Mock;
  destroy: jest.Mock;
}

const state = {
  options: undefined as Record<string, unknown> | undefined,
  onConnection: undefined as ((core: FakeCore) => void) | undefined,
  queue: [] as FakeConn[],
  ended: false,
};

jest.mock("mysql2/promise", () => ({
  __esModule: true,
  default: {
    createPool: (options: Record<string, unknown>) => {
      state.options = options;
      return {
        pool: {
          on: (event: string, handler: (core: FakeCore) => void) => {
            if (event === "connection") state.onConnection = handler;
          },
        },
        getConnection: async () => {
          const next = state.queue.shift();
          if (next === undefined) throw new Error("no connection scripted");
          return next;
        },
        end: async () => {
          state.ended = true;
        },
      };
    },
  },
}));

const config = { host: "db", port: "3307", user: "u", password: "p", database: "d" };

function connection(): FakeConn {
  return {
    connection: { query: jest.fn(), destroy: jest.fn() },
    execute: jest.fn(async () => [[["row"]], []]),
    ping: jest.fn(async () => undefined),
    release: jest.fn(),
    destroy: jest.fn(),
  };
}

/** A pool whose clock the test moves; `born` is when the next connection is announced. */
function pool() {
  const clock = { t: 1_000_000 };
  state.queue = [];
  const sql = new MysqlSql(config, () => clock.t);
  /** Announces a connection to the pool's 'connection' event, as mysql2 does when it opens one, and queues it. */
  const open = (): FakeConn => {
    const c = connection();
    state.onConnection?.(c.connection);
    state.queue.push(c);
    return c;
  };
  return { sql, clock, open };
}

describe("the pool options", () => {
  it("pin the DSN of the Go service: utf8mb4, UTC, big numbers as strings, dates as text, 10 connections, 10 idle", () => {
    const o = poolOptions(config);
    expect(o).toMatchObject({
      host: "db",
      port: 3307,
      user: "u",
      password: "p",
      database: "d",
      charset: "UTF8MB4_GENERAL_CI",
      timezone: "Z",
      supportBigNumbers: true,
      bigNumberStrings: true,
      dateStrings: true,
      connectionLimit: 10,
      maxIdle: 10,
      waitForConnections: true,
      enableKeepAlive: true,
    });
    expect(MAX_OPEN_CONNS).toBe(10);
    expect(CONN_MAX_LIFETIME_MS).toBe(180_000);
  });

  it("are the ones the pool is created with", () => {
    pool();
    expect(state.options).toEqual(poolOptions(config));
  });
});

describe("MysqlSql", () => {
  it("sets the session time zone to UTC on every new connection", () => {
    const { open } = pool();
    const c = open();
    expect(c.connection.query).toHaveBeenCalledTimes(1);
    expect(c.connection.query.mock.calls[0]?.[0]).toBe("SET time_zone='+00:00'");
  });

  it("a connection whose time zone could not be set is closed", () => {
    const { open } = pool();
    const c = open();
    (c.connection.query.mock.calls[0]?.[1] as (err: Error | null) => void)(null);
    expect(c.connection.destroy).not.toHaveBeenCalled();
    (c.connection.query.mock.calls[0]?.[1] as (err: Error | null) => void)(new Error("nope"));
    expect(c.connection.destroy).toHaveBeenCalledTimes(1);
  });

  it("runs a prepared statement with its parameters, rows by position, and gives the connection back", async () => {
    const { sql, open } = pool();
    const c = open();
    const rows = await sql.execute("SELECT ?", ["a", 1, null]);
    expect(rows).toEqual([["row"]]);
    expect(c.execute).toHaveBeenCalledWith({ sql: "SELECT ?", values: ["a", 1, null], rowsAsArray: true });
    expect(c.release).toHaveBeenCalledTimes(1);
    expect(c.destroy).not.toHaveBeenCalled();
  });

  it("an INSERT's answer is no rows", async () => {
    const { sql, open } = pool();
    const c = open();
    c.execute.mockResolvedValueOnce([{ affectedRows: 1 }, undefined]);
    expect(await sql.execute("INSERT")).toEqual([]);
  });

  it("gives the connection back when the statement fails, and the failure is the caller's", async () => {
    const { sql, open } = pool();
    const c = open();
    c.execute.mockRejectedValueOnce(new Error("Data too long"));
    await expect(sql.execute("INSERT")).rejects.toThrow("Data too long");
    expect(c.release).toHaveBeenCalledTimes(1);
  });

  it("a connection is used until it is 3 minutes old, and that minute included", async () => {
    const { sql, clock, open } = pool();
    const c = open();
    clock.t += CONN_MAX_LIFETIME_MS;
    await sql.execute("SELECT 1");
    expect(c.execute).toHaveBeenCalledTimes(1);
    expect(c.destroy).not.toHaveBeenCalled();
  });

  it("an older connection is closed and another is taken in its place", async () => {
    const { sql, clock, open } = pool();
    const old = open();
    clock.t += CONN_MAX_LIFETIME_MS + 1;
    const fresh = open();
    await sql.execute("SELECT 1");
    expect(old.destroy).toHaveBeenCalledTimes(1);
    expect(old.execute).not.toHaveBeenCalled();
    expect(old.release).not.toHaveBeenCalled();
    expect(fresh.execute).toHaveBeenCalledTimes(1);
    expect(fresh.release).toHaveBeenCalledTimes(1);
  });

  it("the age counts from when the connection was opened, not from when it was last used", async () => {
    const { sql, clock, open } = pool();
    const c = open();
    clock.t += 100_000;
    await sql.execute("SELECT 1");
    state.queue.push(c);
    clock.t += 100_000;
    const fresh = open();
    await sql.execute("SELECT 1");
    expect(c.destroy).toHaveBeenCalledTimes(1);
    expect(fresh.execute).toHaveBeenCalledTimes(1);
  });

  it("pings on a connection it has checked, and gives it back", async () => {
    const { sql, open } = pool();
    const c = open();
    await sql.ping();
    expect(c.ping).toHaveBeenCalledTimes(1);
    expect(c.release).toHaveBeenCalledTimes(1);
  });

  it("a ping that fails still gives the connection back", async () => {
    const { sql, open } = pool();
    const c = open();
    c.ping.mockRejectedValueOnce(new Error("gone"));
    await expect(sql.ping()).rejects.toThrow("gone");
    expect(c.release).toHaveBeenCalledTimes(1);
  });

  it("closes the pool", async () => {
    const { sql } = pool();
    state.ended = false;
    await sql.close();
    expect(state.ended).toBe(true);
  });
});
