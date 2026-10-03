/**
 * @file The one door to MySQL: raw SQL with `?` placeholders, run as prepared statements (what
 * go-sql-driver does without interpolateParams), on a pool with Go's bounds.
 *
 * Nothing above this file imports `mysql2`; the store (history.ts) and the migration (migrate.ts)
 * take a `Sql`, which the unit tests replace with a recorder.
 *
 * What the Go service's DSN pinned (src/db/db.go) and how it is pinned here:
 *
 *  - the session time zone is UTC: `SET time_zone='+00:00'` on every new connection (the DSN's
 *    `time_zone` parameter does the same), and times travel as UTC text (time.ts);
 *  - at most 10 connections, 10 idle, none older than 3 minutes. mysql2's pool has no lifetime,
 *    so it is checked when a connection is taken: an older one is closed and another taken, which
 *    is also when database/sql notices (a connection that outlives the server's idea of it is a
 *    spurious "invalid connection" on the next query);
 *  - a BIGINT (and a COUNT) comes back as a string, never rounded through a double. Going in,
 *    every int64 is sent as its decimal text, which MySQL converts exactly (or refuses when it does
 *    not fit the column), where a JavaScript number would lose what is above 2^53;
 *  - a TIMESTAMP comes back as the text MySQL wrote, not as a Date;
 *  - rows are positional arrays, like Go's Scan, so no column label (its case differs between
 *    information_schema versions) is ever read.
 */

import mysql from "mysql2/promise";
import type { MySqlConfig } from "../config";

/** What goes into a placeholder: text (also for a number above 2^53, an int64, a time), a small number, or NULL. */
export type SqlValue = string | number | Buffer | null;
/** One row, columns by position; a BIGINT is a string. */
export type SqlRow = readonly unknown[];

export interface Sql {
  /** Runs one statement. Resolves with the rows of a SELECT (none for anything else); rejects with the driver's error. */
  execute(sql: string, params?: readonly SqlValue[]): Promise<SqlRow[]>;
  /** Takes a connection and pings it (database/sql's Ping). */
  ping(): Promise<void>;
  close(): Promise<void>;
}

/** MySQL drops idle connections after wait_timeout (8h by default, far lower behind most proxies). Recycling well inside that avoids the spurious "invalid connection". */
export const CONN_MAX_LIFETIME_MS = 3 * 60 * 1000;
export const MAX_OPEN_CONNS = 10;

/** The pool options for a configuration. Exported so a test can pin them. */
export function poolOptions(config: MySqlConfig): mysql.PoolOptions {
  return {
    host: config.host,
    port: Number(config.port),
    user: config.user,
    password: config.password,
    database: config.database,
    // go-sql-driver's default: utf8mb4 with general_ci. Needed for the emoji and the accents the history round-trips.
    charset: "UTF8MB4_GENERAL_CI",
    // How a JS Date would be written; no Date is ever sent (times are UTC text), but nothing may depend on the host's zone.
    timezone: "Z",
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
    connectionLimit: MAX_OPEN_CONNS,
    maxIdle: MAX_OPEN_CONNS,
    waitForConnections: true,
    queueLimit: 0,
    enableKeepAlive: true,
  };
}

export class MysqlSql implements Sql {
  private readonly pool: mysql.Pool;
  private readonly born = new WeakMap<object, number>();
  private readonly now: () => number;

  constructor(config: MySqlConfig, now: () => number = Date.now) {
    this.now = now;
    this.pool = mysql.createPool(poolOptions(config));
    // A new connection: UTC first (its command queue runs this before anything a caller asks), and the clock for its lifetime.
    this.pool.pool.on("connection", (connection) => {
      this.born.set(connection, this.now());
      connection.query("SET time_zone='+00:00'", (err) => {
        if (err !== null) connection.destroy();
      });
    });
  }

  /** A connection younger than the lifetime; older ones are closed on the way. */
  private async take(): Promise<mysql.PoolConnection> {
    for (;;) {
      const connection = await this.pool.getConnection();
      const born = this.born.get(connection.connection) ?? this.now();
      if (this.now() - born <= CONN_MAX_LIFETIME_MS) return connection;
      connection.destroy();
    }
  }

  async execute(sql: string, params: readonly SqlValue[] = []): Promise<SqlRow[]> {
    const connection = await this.take();
    try {
      const [rows] = await connection.execute({ sql, values: [...params], rowsAsArray: true });
      return Array.isArray(rows) ? (rows as unknown as SqlRow[]) : [];
    } finally {
      connection.release();
    }
  }

  async ping(): Promise<void> {
    const connection = await this.take();
    try {
      await connection.ping();
    } finally {
      connection.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
