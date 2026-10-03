import { Controller, Get, Path, Query, Request, Response, Route, Tags } from "@tsoa/runtime";
import type { Request as ExpressRequest } from "express";
import { isTransactionType, transactionTypeNames, type TransactionType as StoredType } from "../db/history";
import { TextAnswer } from "../http/json";
import { segmentFromEnd } from "../http/muxCompat";
import { atoi, Query as GoQuery, rawQueryOf } from "../http/query";
import { textOrBytes } from "../persistence";
import type { Delivery, Transaction, TransactionType } from "./models";
import { answer, historyOf } from "./support";

/** limit: the default, and the most one answer holds. */
export const DEFAULT_TRANSACTION_LIMIT = 100;
export const MAX_TRANSACTION_LIMIT = 1000;

/**
 * The two public reads, served entirely from this service's own MySQL history. A visitor with no
 * header is served; a presented token is still introspected, and a bad one is a 401, never a
 * visitor (routePolicy in auth.ts). Lists are `[]`, never `null`.
 */
@Route("api/agent/v1")
@Response<string>(503, "a token was presented and auth-service could not be asked")
export class HistoryController extends Controller {
  /**
   * The recorded deliveries of a contract, oldest first.
   * @param contractId Contract ID
   */
  @Tags("contracts")
  @Response<string>(500, "failed to load deliveries")
  @Get("contracts/{contractId}/deliveries")
  public async getDeliveries(@Path() contractId: string, @Request() req: ExpressRequest): Promise<Delivery[]> {
    let rows;
    try {
      // The id is matched by MySQL, under its collation (case and accents are ignored), never in this process.
      rows = await historyOf(req).deliveriesForContract(textOrBytes(segmentFromEnd(req, 1)));
    } catch (err) {
      throw new TextAnswer(500, `failed to load deliveries: ${err instanceof Error ? err.message : String(err)}`);
    }
    return await answer<Delivery[]>(req, rows);
  }

  /**
   * Ship purchases, cargo purchases and cargo sells, newest first. Optionally filtered by ship symbol
   * and/or type.
   *
   * The query string is read by the handler with Go's rules (the first of a repeated name wins, a pair
   * with a `;` or a bad escape is dropped, names are case sensitive), so Express' parser is off and
   * these parameters are documented only: nothing validates them before the handler runs. A bad `type`
   * is reported before a bad `limit`; both are 400 and need no session.
   * @param shipSymbol Filter by ship symbol
   * @param type Filter by transaction type
   * @isInt limit
   * @param limit Max results, 1-1000 (default 100; a larger value is capped at 1000)
   */
  @Tags("ships")
  @Response<string>(400, "invalid query parameter")
  @Response<string>(500, "failed to load transactions")
  @Get("transactions")
  public async getTransactions(
    @Request() req: ExpressRequest,
    @Query() shipSymbol?: string,
    @Query() type?: TransactionType,
    @Query() limit?: number,
  ): Promise<Transaction[]> {
    const query = new GoQuery(rawQueryOf(req.url));

    // An unrecognised type used to fall through as a filter that matches nothing, so a typo looked exactly like an empty history.
    let wanted: StoredType | null = null;
    const rawType = query.get("type");
    if (rawType.length > 0) {
      const name = rawType.toString("latin1");
      if (!isTransactionType(name)) throw new TextAnswer(400, `type must be one of: ${transactionTypeNames()}`);
      wanted = name;
    }

    // An unparseable limit used to be silently replaced by the default, and an arbitrarily large one was passed straight to MySQL.
    let count = DEFAULT_TRANSACTION_LIMIT;
    const rawLimit = query.get("limit");
    if (rawLimit.length > 0) {
      const parsed = atoi(rawLimit);
      if (parsed === null || parsed <= 0n) throw new TextAnswer(400, "limit must be a positive integer");
      count = Number(parsed < BigInt(MAX_TRANSACTION_LIMIT) ? parsed : BigInt(MAX_TRANSACTION_LIMIT));
    }

    let rows;
    try {
      rows = await historyOf(req).listTransactions({ shipSymbol: textOrBytes(query.get("shipSymbol")), type: wanted, limit: count });
    } catch (err) {
      throw new TextAnswer(500, `failed to load transactions: ${err instanceof Error ? err.message : String(err)}`);
    }
    return await answer<Transaction[]>(req, rows);
  }
}
