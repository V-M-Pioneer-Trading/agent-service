import { Body, Controller, Path, Post, Request, Response, Route, Tags } from "@tsoa/runtime";
import type { Request as ExpressRequest } from "express";
import type { Caller, GatewayClient } from "../gateway/client";
import { cargoTransactionRequestSchema, purchaseShipRequestSchema } from "../gateway/schema";
import type { MarketTransactionResult as DecodedResult } from "../gateway/schema";
import { decodeBody } from "../http/body";
import { TextAnswer } from "../http/json";
import { segmentFromEnd } from "../http/muxCompat";
import { persistCargoTrade, persistShipPurchase } from "../persistence";
import type { CargoTransactionRequest, MarketTransactionResult, PurchaseShipRequest, PurchaseShipResult } from "./models";
import { answer, callerOf, errorLogOf, gatewayOf, historyOf } from "./support";

/**
 * The ship writes: they move credits, so they live here and not in fleet-service, which does not own
 * the transaction history. Each needs a session carrying `fleet:control` (routePolicy in auth.ts),
 * forwards that session to st-gateway, and records the purchase or sale after the gateway says it
 * happened (best effort: a failed write is logged and the answer is still the gateway's).
 *
 * The bodies are read by the handlers, not by tsoa: the first JSON value, whatever follows it
 * ignored, member names in any case, Content-Type never checked, at most 1 MiB. Each is declared
 * optional below only so that it is documented: nothing validates it before the handler runs
 * (no body parser is mounted). A body error, then a missing member, are answered before the
 * gateway is asked.
 */
@Route("api/agent/v1")
@Response<string>(400, "invalid request body, or a member is missing")
@Response<string>(401, "no verified session")
@Response<string>(403, "session lacks fleet:control")
@Response<string>(502, "st-gateway answered with something unreadable")
@Response<string>(503, "auth-service could not be asked")
@Response<string>(504, "st-gateway did not answer")
export class ShipsController extends Controller {
  /** Calls SpaceTraders' purchase-ship, then records the transaction in the history. */
  @Tags("ships")
  @Post("ships/purchase")
  public async purchaseShip(@Request() req: ExpressRequest, @Body() purchase?: PurchaseShipRequest): Promise<PurchaseShipResult> {
    const body = await decodeBody(req, purchaseShipRequestSchema);
    if (body.shipType === "" || body.waypointSymbol === "") {
      throw new TextAnswer(400, "shipType and waypointSymbol are required");
    }
    const result = await gatewayOf(req).purchaseShip(callerOf(req), body.shipType, body.waypointSymbol);
    await persistShipPurchase(historyOf(req), result, errorLogOf(req));
    return await answer<PurchaseShipResult>(req, result);
  }

  /**
   * Calls SpaceTraders' purchase-cargo, then records the transaction in the history.
   * @param shipSymbol Ship symbol
   */
  @Tags("ships")
  @Post("ships/{shipSymbol}/purchase")
  public async purchaseCargo(@Path() shipSymbol: string, @Request() req: ExpressRequest, @Body() trade?: CargoTransactionRequest): Promise<MarketTransactionResult> {
    return await this.tradeCargo(req, "PURCHASE", (gateway, caller, ship, good, units) => gateway.purchaseCargo(caller, ship, good, units));
  }

  /**
   * Calls SpaceTraders' sell-cargo, then records the transaction in the history.
   * @param shipSymbol Ship symbol
   */
  @Tags("ships")
  @Post("ships/{shipSymbol}/sell")
  public async sellCargo(@Path() shipSymbol: string, @Request() req: ExpressRequest, @Body() trade?: CargoTransactionRequest): Promise<MarketTransactionResult> {
    return await this.tradeCargo(req, "SELL", (gateway, caller, ship, good, units) => gateway.sellCargo(caller, ship, good, units));
  }

  /** Purchase-cargo and sell-cargo: same body, same answer, same history row modulo its type. */
  private async tradeCargo(
    req: ExpressRequest,
    type: "PURCHASE" | "SELL",
    call: (gateway: GatewayClient, caller: Caller, ship: Uint8Array, good: string, units: bigint) => Promise<DecodedResult>,
  ): Promise<MarketTransactionResult> {
    const body = await decodeBody(req, cargoTransactionRequestSchema);
    if (body.symbol === "" || body.units <= 0n) {
      throw new TextAnswer(400, "symbol and units (>0) are required");
    }
    // The ship is the second to last segment of the decoded path, as bytes; the history takes it from here, not from the answer.
    const ship = segmentFromEnd(req, 1);
    const result = await call(gatewayOf(req), callerOf(req), ship, body.symbol, body.units);
    await persistCargoTrade(historyOf(req), type, ship, result, errorLogOf(req));
    return await answer<MarketTransactionResult>(req, result);
  }
}
