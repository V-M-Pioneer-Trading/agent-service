import { Body, Controller, Path, Post, Request, Response, Route, Tags } from "@tsoa/runtime";
import type { Request as ExpressRequest } from "express";
import { symbolColumn, persistContract } from "../persistence";
import { decodeBody } from "../http/body";
import { TextAnswer } from "../http/json";
import { segmentFromEnd } from "../http/muxCompat";
import { instantOfDate, toRfc3339, toSqlTime } from "../db/time";
import { deliveryRequestSchema } from "../gateway/schema";
import type { Delivery as StoredDelivery } from "../db/history";
import type { Caller, GatewayClient } from "../gateway/client";
import type { ContractAndAgent as Decoded } from "../gateway/schema";
import type { ContractAndAgent, Delivery, DeliveryRequest } from "./models";
import { answer, callerOf, errorLogOf, gatewayOf, historyOf } from "./support";

/**
 * The contract writes. Each needs a session carrying `fleet:control` (routePolicy in auth.ts; the
 * header is checked before anything here runs) and forwards the caller's own session to
 * st-gateway. Upstream failures are relayed as on the reads: the gateway's status and sentence as
 * text/plain with its pacing headers; 502 for a 2xx that does not fit the shapes; 504 when the
 * gateway does not answer.
 */
@Route("api/agent/v1")
@Response<string>(401, "no verified session")
@Response<string>(403, "session lacks fleet:control")
@Response<string>(503, "auth-service could not be asked")
export class ContractsController extends Controller {
  /**
   * Calls SpaceTraders' accept-contract, then persists the resulting contract state (best effort:
   * a failed write is logged and the answer is still the gateway's).
   * @param contractId Contract ID
   */
  @Tags("contracts")
  @Response<string>(502, "st-gateway answered with something unreadable")
  @Response<string>(504, "st-gateway did not answer")
  @Post("contracts/{contractId}/accept")
  public async acceptContract(@Path() contractId: string, @Request() req: ExpressRequest): Promise<ContractAndAgent> {
    return await this.contractStateChange(req, (gateway, caller, id) => gateway.acceptContract(caller, id));
  }

  /**
   * Calls SpaceTraders' fulfill-contract, then persists the resulting contract state.
   * @param contractId Contract ID
   */
  @Tags("contracts")
  @Response<string>(502, "st-gateway answered with something unreadable")
  @Response<string>(504, "st-gateway did not answer")
  @Post("contracts/{contractId}/fulfill")
  public async fulfillContract(@Path() contractId: string, @Request() req: ExpressRequest): Promise<ContractAndAgent> {
    return await this.contractStateChange(req, (gateway, caller, id) => gateway.fulfillContract(caller, id));
  }

  /** Accept and fulfill: same inputs (none, no body is read), same answer, same persistence step. */
  private async contractStateChange(
    req: ExpressRequest,
    call: (gateway: GatewayClient, caller: Caller, id: Uint8Array) => Promise<Decoded>,
  ): Promise<ContractAndAgent> {
    // The id is the second to last segment of the decoded path, as bytes.
    const result = await call(gatewayOf(req), callerOf(req), segmentFromEnd(req, 1));
    await persistContract(historyOf(req), result.contract, errorLogOf(req));
    return await answer<ContractAndAgent>(req, result);
  }

  /**
   * Records one delivery against a contract. Called by fleet-service after a successful
   * deliver-contract action on SpaceTraders, forwarding its caller's session.
   *
   * The body is read by this handler, not by tsoa: the first JSON value, whatever follows it ignored,
   * member names in any case, Content-Type never checked, at most 1 MiB. It is declared optional
   * below only so that it is documented: nothing validates it before the handler runs.
   * @param contractId Contract ID
   */
  @Tags("contracts")
  @Response<string>(400, "invalid request body, or a member is missing")
  @Response<string>(500, "failed to record delivery")
  @Post("contracts/{contractId}/deliveries")
  public async recordDelivery(@Path() contractId: string, @Request() req: ExpressRequest, @Body() _delivery?: DeliveryRequest): Promise<Delivery> {
    const body = await decodeBody(req, deliveryRequestSchema);
    if (body.shipSymbol === "" || body.tradeSymbol === "" || body.units <= 0n) {
      throw new TextAnswer(400, "shipSymbol, tradeSymbol and units (>0) are required");
    }
    const at = instantOfDate(new Date());
    let row: StoredDelivery;
    try {
      // The contract id is the path segment as the router decoded it; MySQL refuses it when it is not UTF-8.
      const id = symbolColumn(segmentFromEnd(req, 1));
      await historyOf(req).insertDelivery({ contractId: id, shipSymbol: body.shipSymbol, tradeSymbol: body.tradeSymbol, units: body.units, deliveredAt: toSqlTime(at) });
      row = { contractId: id, shipSymbol: body.shipSymbol, tradeSymbol: body.tradeSymbol, units: body.units, deliveredAt: toRfc3339(at) };
    } catch (err) {
      throw new TextAnswer(500, `failed to record delivery: ${err instanceof Error ? err.message : String(err)}`);
    }
    return await answer<Delivery>(req, row);
  }
}
