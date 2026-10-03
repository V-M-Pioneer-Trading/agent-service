import { Controller, Get, Path, Request, Response, Route, Tags } from "@tsoa/runtime";
import type { Request as ExpressRequest } from "express";
import { lastSegmentOf } from "../http/muxCompat";
import type { Agent, Contract, CurrentAgent, Ship } from "./models";
import { answer, callerOf, gatewayOf } from "./support";

/**
 * The live reads: each one asks st-gateway (which owns the shared rate budget
 * and injects the game credential) on the caller's own session and answers
 * with what it said, decoded into the shapes in models.ts and written back.
 *
 * A verified session is required, no particular scope (routePolicy in auth.ts).
 * Upstream failures: the gateway's own status and sentence as text/plain with
 * its pacing headers (Retry-After, X-RateLimit-*); 502 for a 2xx that does not
 * fit the shapes; 504 when the gateway does not answer. Failures are thrown and
 * relayed by the app's error handler.
 */
@Route("api/agent/v1")
@Response<string>(401, "no verified session")
@Response<string>(502, "st-gateway answered with something unreadable")
@Response<string>(503, "auth-service could not be asked")
@Response<string>(504, "st-gateway did not answer")
export class AgentController extends Controller {
  /** The three reads below in one call, made one after the other; the first failure is the answer. */
  @Tags("agent")
  @Get("current-agent")
  public async getCurrentAgent(@Request() req: ExpressRequest): Promise<CurrentAgent> {
    const gateway = gatewayOf(req);
    const caller = callerOf(req);
    const agent = await gateway.getMyAgent(caller);
    const ships = await gateway.getMyShips(caller);
    const contracts = await gateway.getMyContracts(caller);
    return await answer<CurrentAgent>(req, { agent, ships, contracts });
  }

  /** The current agent's profile. */
  @Tags("agent")
  @Get("agent")
  public async getAgent(@Request() req: ExpressRequest): Promise<Agent> {
    return await answer<Agent>(req, await gatewayOf(req).getMyAgent(callerOf(req)));
  }

  /** The agent's ships; null when the gateway sent none. */
  @Tags("ships")
  @Get("ships")
  public async getShips(@Request() req: ExpressRequest): Promise<Ship[] | null> {
    return await answer<Ship[] | null>(req, await gatewayOf(req).getMyShips(callerOf(req)));
  }

  /**
   * A single ship.
   * @param shipSymbol Ship symbol
   */
  @Tags("ships")
  @Response<string>(404, "ship not found")
  @Get("ships/{shipSymbol}")
  public async getShip(@Path() shipSymbol: string, @Request() req: ExpressRequest): Promise<Ship> {
    // The symbol is read from the request itself: Express' own copy of it fails on bytes that are not UTF-8.
    return await answer<Ship>(req, await gatewayOf(req).getMyShip(callerOf(req), lastSegmentOf(req)));
  }

  /** The agent's contracts; null when the gateway sent none. */
  @Tags("contracts")
  @Get("contracts")
  public async getContracts(@Request() req: ExpressRequest): Promise<Contract[] | null> {
    return await answer<Contract[] | null>(req, await gatewayOf(req).getMyContracts(callerOf(req)));
  }

  /**
   * A single contract.
   * @param contractId Contract ID
   */
  @Tags("contracts")
  @Response<string>(404, "contract not found")
  @Get("contracts/{contractId}")
  public async getContract(@Path() contractId: string, @Request() req: ExpressRequest): Promise<Contract> {
    return await answer<Contract>(req, await gatewayOf(req).getMyContract(callerOf(req), lastSegmentOf(req)));
  }
}
