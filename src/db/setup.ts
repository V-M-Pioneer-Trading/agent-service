/**
 * @file SetUpDatabase: open the pool, wait for MySQL to accept connections, migrate.
 *
 * Returns an error rather than exiting, so the caller owns the process lifecycle (server.ts
 * exits 1 like `log.Fatal`) and so it is reachable from a test.
 */

import type { MySqlConfig } from "../config";
import { migrate } from "./migrate";
import { MysqlSql, type Sql } from "./sql";

/**
 * MySQL's startup window: docker-compose's depends_on waits for the container, not for MySQL
 * to accept connections.
 */
export const PING_ATTEMPTS = 15;
export const PING_DELAY_MS = 2000;

export interface SetUpDeps {
  readonly log?: (line: string) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Builds the pool; replaced in tests. */
  readonly open?: (config: MySqlConfig) => Sql;
}

export async function waitForDatabase(
  sql: Sql,
  log: (line: string) => void = console.log,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<void> {
  let last: unknown;
  for (let attempt = 1; attempt <= PING_ATTEMPTS; attempt++) {
    try {
      await sql.ping();
      return;
    } catch (err) {
      last = err;
    }
    log(`DB not ready yet (attempt ${attempt}/${PING_ATTEMPTS}): ${last instanceof Error ? last.message : String(last)}`);
    if (attempt < PING_ATTEMPTS) await sleep(PING_DELAY_MS);
  }
  throw last;
}

export async function setUpDatabase(config: MySqlConfig, deps: SetUpDeps = {}): Promise<Sql> {
  const log = deps.log ?? ((line: string) => console.log(line));
  log("Establishing connection to MySql DB...");
  const sql = (deps.open ?? ((c: MySqlConfig) => new MysqlSql(c)))(config);
  try {
    await waitForDatabase(sql, log, deps.sleep);
    log("Connection to DB is established.");
    await migrate(sql, log);
    log("Schema migrations applied.");
    return sql;
  } catch (err) {
    await sql.close().catch(() => undefined);
    throw err;
  }
}
