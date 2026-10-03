/**
 * @file persistTransaction and persistContract: history is recorded on a best-effort basis
 * (invariant 5). The SpaceTraders call they follow has already succeeded and cannot be undone, so
 * a failed write is logged and the caller still gets its result: the history is allowed to be
 * incomplete, the game state is not. Nothing here throws.
 *
 * What gets written, and from where (contract README notes 31-32): cargo trades take the ship
 * symbol from the PATH (decoded) and everything else from the gateway's answer, not from the
 * request; a ship purchase takes the new ship's symbol from the answer. `occurredAt` is the
 * gateway's timestamp, or now when it is missing or the zero time. An empty 2xx is a zero result,
 * so it records a zero row.
 */

import { UnencodableTime, stringifyJson, validLength } from "./gateway/json";
import type { Contract, MarketTransactionResult, PurchaseShipResult } from "./gateway/schema";
import type { HistoryStore, NewTransaction, TransactionType } from "./db/history";
import { instantOfDate, instantOfTime, isZeroTime, toSqlTime, type Instant } from "./db/time";

export type Log = (line: string) => void;

/**
 * Bytes as a string, or null when they are not UTF-8. A Go string holds any bytes, MySQL refuses
 * those in a utf8mb4 column, and that refusal is what the history sees; a JavaScript string cannot
 * hold them, so the caller treats null as that refusal.
 */
export function utf8(bytes: Uint8Array): string | null {
  for (let i = 0; i < bytes.length; ) {
    const len = validLength(bytes, i);
    if (len === 0) return null;
    i += len;
  }
  return Buffer.from(bytes).toString("utf8");
}

/** A path symbol as a column value: the refusal MySQL would make, for bytes that are not UTF-8. */
export function symbolColumn(bytes: Uint8Array): string {
  const text = utf8(bytes);
  if (text === null) throw new Error("Incorrect string value: the symbol is not valid UTF-8");
  return text;
}

/** The gateway's timestamp, or now when it is the zero time. */
function occurredAt(stamp: string | UnencodableTime, now: Date): string {
  const instant = instantOfTime(stamp);
  const at: Instant = isZeroTime(instant) ? instantOfDate(now) : instant;
  return toSqlTime(at);
}

async function persist(store: HistoryStore, row: () => NewTransaction, type: TransactionType, ship: () => string, log: Log): Promise<void> {
  try {
    await store.insertTransaction(row());
  } catch (err) {
    let name: string;
    try {
      name = ship();
    } catch {
      name = "?";
    }
    log(`failed to persist ${type} transaction for ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** A ship purchase: the ship comes from the answer. */
export function persistShipPurchase(store: HistoryStore, result: PurchaseShipResult, log: Log, now: () => Date = () => new Date()): Promise<void> {
  const tx = result.transaction;
  return persist(
    store,
    () => ({
      type: "SHIP_PURCHASE",
      shipSymbol: result.ship.symbol,
      waypointSymbol: tx.waypointSymbol,
      shipType: tx.shipType,
      tradeSymbol: null,
      units: null,
      pricePerUnit: null,
      totalPrice: tx.price,
      agentCredits: result.agent.credits,
      occurredAt: occurredAt(tx.timestamp, now()),
    }),
    "SHIP_PURCHASE",
    () => result.ship.symbol,
    log,
  );
}

/** A cargo purchase or sale: the ship comes from the path, bytes as the router decoded them. */
export function persistCargoTrade(
  store: HistoryStore,
  type: "PURCHASE" | "SELL",
  shipSymbol: Uint8Array,
  result: MarketTransactionResult,
  log: Log,
  now: () => Date = () => new Date(),
): Promise<void> {
  const tx = result.transaction;
  return persist(
    store,
    () => ({
      type,
      shipSymbol: symbolColumn(shipSymbol),
      waypointSymbol: tx.waypointSymbol,
      shipType: null,
      tradeSymbol: tx.tradeSymbol,
      units: tx.units,
      pricePerUnit: tx.pricePerUnit,
      totalPrice: tx.totalPrice,
      agentCredits: result.agent.credits,
      occurredAt: occurredAt(tx.timestamp, now()),
    }),
    type,
    () => Buffer.from(shipSymbol).toString("utf8"),
    log,
  );
}

/** accept-contract and fulfill-contract: the contract's latest state. */
export async function persistContract(store: HistoryStore, contract: Contract, log: Log, now: () => Date = () => new Date()): Promise<void> {
  let rawJson: string;
  try {
    // Go's json.Marshal refuses a time with a zone offset of a day or more, and so does the writer.
    rawJson = stringifyJson(contract);
  } catch (err) {
    log(`failed to marshal contract ${contract.id} for persistence: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  try {
    await store.upsertContract({
      id: contract.id,
      factionSymbol: contract.factionSymbol,
      type: contract.type,
      accepted: contract.accepted,
      fulfilled: contract.fulfilled,
      rawJson,
      updatedAt: toSqlTime(instantOfDate(now())),
    });
  } catch (err) {
    log(`failed to persist contract ${contract.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Bytes as a query parameter: text when they are UTF-8, else as they are (MySQL then judges them, as it did for Go's string). */
export function textOrBytes(bytes: Uint8Array): string | Buffer {
  return utf8(bytes) ?? Buffer.from(bytes);
}
