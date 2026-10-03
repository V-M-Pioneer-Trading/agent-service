/**
 * @file The history tables, read and written: src/db/contracts.go and transactions.go.
 *
 * Only this module (and migrate.ts) writes SQL; handlers call the named functions below, never
 * build a query. Values arrive here already shaped for the columns (times as UTC text, int64 as
 * text or bigint) and leave as the JSON answers' own shapes.
 */

import type { Sql, SqlValue } from "./sql";
import { fromSqlTime } from "./time";

/** The credit-moving events this service records; the `?type=` filter is validated against the same list. */
export const TRANSACTION_TYPES = ["SHIP_PURCHASE", "PURCHASE", "SELL"] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export const isTransactionType = (s: string): s is TransactionType => (TRANSACTION_TYPES as readonly string[]).includes(s);
/** For the 400 message. */
export const transactionTypeNames = (): string => TRANSACTION_TYPES.join(", ");

/** A contract's deliveries, as the API shows one (member order is the order of the answer). */
export interface Delivery {
  contractId: string;
  shipSymbol: string;
  tradeSymbol: string;
  units: bigint;
  /** RFC 3339, UTC. */
  deliveredAt: string;
}

/** A history row as the API shows it: a member that is NULL in the table is absent. */
export interface Transaction {
  type: TransactionType;
  shipSymbol: string;
  waypointSymbol: string;
  shipType?: string;
  tradeSymbol?: string;
  units?: bigint;
  pricePerUnit?: bigint;
  totalPrice: bigint;
  agentCredits: bigint;
  /** RFC 3339, UTC, whole seconds. */
  occurredAt: string;
}

/** A row to insert: SQL values, times already as UTC text. */
export interface NewTransaction {
  readonly type: TransactionType;
  readonly shipSymbol: string;
  readonly waypointSymbol: string;
  readonly shipType: string | null;
  readonly tradeSymbol: string | null;
  readonly units: bigint | null;
  readonly pricePerUnit: bigint | null;
  readonly totalPrice: bigint;
  readonly agentCredits: bigint;
  readonly occurredAt: string;
}

export interface NewDelivery {
  readonly contractId: string;
  readonly shipSymbol: string;
  readonly tradeSymbol: string;
  readonly units: bigint;
  readonly deliveredAt: string;
}

export interface NewContract {
  readonly id: string;
  readonly factionSymbol: string;
  readonly type: string;
  readonly accepted: boolean;
  readonly fulfilled: boolean;
  readonly rawJson: string;
  readonly updatedAt: string;
}

export interface TransactionQuery {
  /** "" is no filter on the ship. */
  readonly shipSymbol: string | Buffer;
  readonly type: TransactionType | null;
  readonly limit: number;
}

export const UPSERT_CONTRACT_SQL = `
		INSERT INTO contracts (id, faction_symbol, type, accepted, fulfilled, raw_json, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
			accepted   = VALUES(accepted),
			fulfilled  = VALUES(fulfilled),
			raw_json   = VALUES(raw_json),
			updated_at = VALUES(updated_at)
	`;

export const INSERT_DELIVERY_SQL = `
		INSERT INTO contract_deliveries (contract_id, ship_symbol, trade_symbol, units, delivered_at)
		VALUES (?, ?, ?, ?, ?)
	`;

export const SELECT_DELIVERIES_SQL = `
		SELECT contract_id, ship_symbol, trade_symbol, units, delivered_at
		FROM contract_deliveries WHERE contract_id = ?
		ORDER BY delivered_at ASC
	`;

export const TRANSACTION_COLUMNS = `type, ship_symbol, waypoint_symbol, ship_type, trade_symbol,
	units, price_per_unit, total_price, agent_credits, occurred_at`;

export const INSERT_TRANSACTION_SQL = `
		INSERT INTO transactions (${TRANSACTION_COLUMNS})
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`;

const asInt = (v: unknown): bigint => BigInt(v as string | number | bigint);
const asText = (v: unknown): string => (typeof v === "string" ? v : Buffer.isBuffer(v) ? v.toString("utf8") : String(v));
const orNull = (v: bigint | null): string | null => (v === null ? null : v.toString());

export class HistoryStore {
  private readonly sql: Sql;

  constructor(sql: Sql) {
    this.sql = sql;
  }

  /** The latest known state of a contract, keyed by SpaceTraders' contract id. */
  async upsertContract(c: NewContract): Promise<void> {
    await this.sql.execute(UPSERT_CONTRACT_SQL, [c.id, c.factionSymbol, c.type, c.accepted ? 1 : 0, c.fulfilled ? 1 : 0, c.rawJson, c.updatedAt]);
  }

  /** One deliver-contract event, reported by fleet-service after it delivered cargo on SpaceTraders. */
  async insertDelivery(d: NewDelivery): Promise<void> {
    await this.sql.execute(INSERT_DELIVERY_SQL, [d.contractId, d.shipSymbol, d.tradeSymbol, d.units.toString(), d.deliveredAt]);
  }

  /** A contract's recorded deliveries, oldest first. Never null: no deliveries is []. The id is compared under MySQL's collation, in MySQL. */
  async deliveriesForContract(contractId: string | Buffer): Promise<Delivery[]> {
    const rows = await this.sql.execute(SELECT_DELIVERIES_SQL, [contractId]);
    return rows.map(
      (r): Delivery => ({
        contractId: asText(r[0]),
        shipSymbol: asText(r[1]),
        tradeSymbol: asText(r[2]),
        units: asInt(r[3]),
        deliveredAt: fromSqlTime(asText(r[4])),
      }),
    );
  }

  /** A ship purchase, a cargo purchase or a cargo sale, recorded right after the SpaceTraders call that made it. */
  async insertTransaction(t: NewTransaction): Promise<void> {
    await this.sql.execute(INSERT_TRANSACTION_SQL, [
      t.type,
      t.shipSymbol,
      t.waypointSymbol,
      t.shipType,
      t.tradeSymbol,
      orNull(t.units),
      orNull(t.pricePerUnit),
      t.totalPrice.toString(),
      t.agentCredits.toString(),
      t.occurredAt,
    ]);
  }

  /** Transactions, newest first, optionally narrowed to a ship and/or a type. Never null. */
  async listTransactions(q: TransactionQuery): Promise<Transaction[]> {
    let query = `SELECT ${TRANSACTION_COLUMNS} FROM transactions`;
    const conditions: string[] = [];
    const args: SqlValue[] = [];
    if (q.shipSymbol.length > 0) {
      conditions.push("ship_symbol = ?");
      args.push(q.shipSymbol);
    }
    if (q.type !== null) {
      conditions.push("type = ?");
      args.push(q.type);
    }
    if (conditions.length > 0) query += ` WHERE ${conditions.join(" AND ")}`;
    query += " ORDER BY occurred_at DESC LIMIT ?";
    // As text: the binary protocol sends a number as a double, which LIMIT refuses.
    args.push(String(q.limit));

    const rows = await this.sql.execute(query, args);
    return rows.map((r): Transaction => {
      const t: Transaction = { type: asText(r[0]) as TransactionType, shipSymbol: asText(r[1]), waypointSymbol: asText(r[2]) } as Transaction;
      if (r[3] !== null) t.shipType = asText(r[3]);
      if (r[4] !== null) t.tradeSymbol = asText(r[4]);
      if (r[5] !== null) t.units = asInt(r[5]);
      if (r[6] !== null) t.pricePerUnit = asInt(r[6]);
      t.totalPrice = asInt(r[7]);
      t.agentCredits = asInt(r[8]);
      t.occurredAt = fromSqlTime(asText(r[9]));
      return t;
    });
  }
}
