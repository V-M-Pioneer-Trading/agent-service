/**
 * @file The schema and its idempotent migration: the former Go service's src/db/db.go (deleted in agent-service#38; `git show 65bb4b2:src/db/db.go`), statement for statement, so a
 * database written by the Go image is read and written by this one and the other way round.
 * The schema does not change.
 *
 * `Migrate` runs on every boot (invariant 7): every statement is `IF NOT EXISTS` or guarded by an
 * information_schema lookup. Order: create tables, widen columns, create indexes: widening must
 * precede indexing, so an index is never built on a column about to be rebuilt.
 */

import type { Sql } from "./sql";

// Money columns are BIGINT, not INT: a late-game agent's credit balance passes INT's
// 2,147,483,647 ceiling, and MySQL in strict mode rejects the insert at that point (in
// non-strict mode it silently clamps, which is worse). One statement per table: the driver
// does not run several in one call.
export const SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS contracts (
		id             VARCHAR(64) PRIMARY KEY,
		faction_symbol VARCHAR(64) NOT NULL,
		type           VARCHAR(32) NOT NULL,
		accepted       BOOLEAN NOT NULL DEFAULT FALSE,
		fulfilled      BOOLEAN NOT NULL DEFAULT FALSE,
		raw_json       JSON NOT NULL,
		updated_at     TIMESTAMP NOT NULL
	)`,
  `CREATE TABLE IF NOT EXISTS contract_deliveries (
		id            INT AUTO_INCREMENT PRIMARY KEY,
		contract_id   VARCHAR(64) NOT NULL,
		ship_symbol   VARCHAR(64) NOT NULL,
		trade_symbol  VARCHAR(64) NOT NULL,
		units         INT NOT NULL,
		delivered_at  TIMESTAMP NOT NULL
	)`,
  `CREATE TABLE IF NOT EXISTS transactions (
		id              INT AUTO_INCREMENT PRIMARY KEY,
		type            VARCHAR(32) NOT NULL,
		ship_symbol     VARCHAR(64) NOT NULL,
		waypoint_symbol VARCHAR(64) NOT NULL,
		ship_type       VARCHAR(64) NULL,
		trade_symbol    VARCHAR(64) NULL,
		units           INT NULL,
		price_per_unit  INT NULL,
		total_price     BIGINT NOT NULL,
		agent_credits   BIGINT NOT NULL,
		occurred_at     TIMESTAMP NOT NULL
	)`,
];

/**
 * Money columns created as INT by earlier versions. MySQL has no conditional DDL, so the
 * migration is guarded by a catalogue lookup instead: a bare ALTER on every boot would rebuild the
 * table each time.
 */
export const WIDENED_COLUMNS: readonly { readonly table: string; readonly column: string; readonly definition: string }[] = [
  { table: "transactions", column: "total_price", definition: "BIGINT NOT NULL" },
  { table: "transactions", column: "agent_credits", definition: "BIGINT NOT NULL" },
];

/**
 * The only two access patterns either history table has: newest first, optionally narrowed to one
 * ship or one contract. MySQL has no CREATE INDEX IF NOT EXISTS, so these are likewise guarded by
 * a catalogue lookup.
 */
export const INDEXES: readonly { readonly table: string; readonly name: string; readonly columns: string }[] = [
  { table: "contract_deliveries", name: "idx_deliveries_contract", columns: "(contract_id, delivered_at)" },
  { table: "transactions", name: "idx_transactions_occurred", columns: "(occurred_at)" },
  { table: "transactions", name: "idx_transactions_ship", columns: "(ship_symbol, occurred_at)" },
];

export const COLUMN_TYPE_SQL = `
		SELECT DATA_TYPE FROM information_schema.COLUMNS
		WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?
	`;

export const INDEX_EXISTS_SQL = `
		SELECT COUNT(*) FROM information_schema.STATISTICS
		WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?
	`;

/** The declared type of a column, or "" when the table or column does not exist. */
async function columnType(sql: Sql, table: string, column: string): Promise<string> {
  const rows = await sql.execute(COLUMN_TYPE_SQL, [table, column]);
  const value = rows[0]?.[0];
  // The catalogue's text columns may arrive as bytes.
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- null and undefined are handled above; the catalogue's text column is a string or a Buffer, whose String() is its UTF-8 text
  return value === undefined || value === null ? "" : String(value);
}

async function indexExists(sql: Sql, table: string, name: string): Promise<boolean> {
  const rows = await sql.execute(INDEX_EXISTS_SQL, [table, name]);
  return Number(rows[0]?.[0] ?? 0) > 0;
}

/** Idempotent: safe on a fresh database or one created by an earlier version of the service (or by the Go one). */
export async function migrate(sql: Sql, log: (line: string) => void = console.log): Promise<void> {
  for (const statement of SCHEMA) await sql.execute(statement);

  for (const c of WIDENED_COLUMNS) {
    const dataType = await columnType(sql, c.table, c.column);
    if (dataType === "" || dataType === "bigint") continue;
    log(`widening ${c.table}.${c.column} from ${dataType} to ${c.definition}`);
    await sql.execute(`ALTER TABLE ${c.table} MODIFY ${c.column} ${c.definition}`);
  }

  for (const ix of INDEXES) {
    if (await indexExists(sql, ix.table, ix.name)) continue;
    await sql.execute(`CREATE INDEX ${ix.name} ON ${ix.table} ${ix.columns}`);
  }
}
