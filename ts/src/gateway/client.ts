/**
 * @file The only outbound HTTP of the service: src/spacetraders/client.go.
 *
 * Every call goes to `ST_GATEWAY_URL + /proxy + <the SpaceTraders path>` and
 * carries one header of the caller's: Authorization, verbatim, so st-gateway
 * can derive the queue priority from the session (decision 2). No SpaceTraders
 * credential exists here (decision 5).
 *
 * What Go's `http.Client` does, reproduced because the contract pins it:
 *
 *  - redirects (301, 302, 303, 307, 308 with a Location) are followed, at most
 *    ten requests in all, then "st-gateway did not answer"; 301-303 turn a POST
 *    into a GET without a body, 307/308 keep both; Authorization travels only to
 *    the same host or a subdomain of it, and once a hop has left that domain it
 *    stays off for good (Go 1.24, CVE-2024-45336); a redirect without a Location
 *    is the answer itself; fetch's own `redirect: "follow"` would stop at twenty
 *    and strip Authorization on any change of origin. The Location is read as
 *    Go's url.Parse reads it (location.ts);
 *  - one 30 s deadline covers every hop and the reading of the body, and a
 *    caller that hangs up cancels the call (Go's request context);
 *  - a status of 400 or more is the gateway's verdict (errors.ts), anything
 *    else is read whole and decoded (decode.ts).
 *
 * Failures are thrown: an UpstreamError (504: no answer; the gateway's own
 * status), an UnreadableAnswer (502), or CallerGone. The app's error handler
 * relays the first two.
 */

import { decode, DecodeError, type Decoded, type Schema } from "./decode";
import { gatewayDidNotAnswer, REQUEST_TIMEOUT_MS, UnreadableAnswer, UpstreamError, upstreamErrorFrom } from "./errors";
import { hostnameOf, isDomainOrSubdomain, resolveReference } from "./location";
import { getMyAgentResponse, getMyContractResponse, getMyContractsResponse, getMyShipResponse, getMyShipsResponse, type Agent, type Contract, type Ship } from "./schema";
import { pathEscape } from "../http/muxCompat";

/** Go's http.Client stops after ten requests. */
export const MAX_REQUESTS = 10;
const FOLLOWED = new Set([301, 302, 303, 307, 308]);

/** Who is asking: their Authorization header, and a signal that fires when they hang up (Go's request context). */
export interface Caller {
  readonly authorization: string;
  readonly signal?: AbortSignal;
}

/** The caller hung up while the gateway was being asked: nobody is left to answer, and it is not the gateway's fault. */
export class CallerGone extends Error {
  constructor() {
    super("the caller hung up");
    this.name = "CallerGone";
  }
}

export class GatewayClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  /** `proxyUrl` is ST_GATEWAY_URL with its trailing slashes trimmed and "/proxy" appended (config.ts). */
  constructor(proxyUrl: string, fetchImpl: typeof fetch = fetch) {
    this.base = proxyUrl;
    this.fetchImpl = fetchImpl;
  }

  async getMyAgent(caller: Caller): Promise<Agent> {
    return (await this.request("GET", "/my/agent", caller, getMyAgentResponse)).data;
  }

  async getMyShips(caller: Caller): Promise<Ship[] | null> {
    return (await this.request("GET", "/my/ships", caller, getMyShipsResponse)).data;
  }

  /** `symbol` is the path segment as the router decoded it: bytes, not necessarily UTF-8. */
  async getMyShip(caller: Caller, symbol: Uint8Array): Promise<Ship> {
    return (await this.request("GET", `/my/ships/${pathEscape(symbol)}`, caller, getMyShipResponse)).data;
  }

  async getMyContracts(caller: Caller): Promise<Contract[] | null> {
    return (await this.request("GET", "/my/contracts", caller, getMyContractsResponse)).data;
  }

  async getMyContract(caller: Caller, id: Uint8Array): Promise<Contract> {
    return (await this.request("GET", `/my/contracts/${pathEscape(id)}`, caller, getMyContractResponse)).data;
  }

  /** One call through st-gateway, its 2xx body decoded into `schema`. */
  private async request<S extends Schema>(method: string, endpoint: string, caller: Caller, schema: S, body?: string): Promise<Decoded<S>> {
    const answer = await this.send(method, endpoint, caller.authorization, body, caller.signal);
    try {
      return decode(schema, answer);
    } catch (err) {
      if (err instanceof DecodeError) throw new UnreadableAnswer(err.message);
      throw err;
    }
  }

  /** The body of the final non-error answer, after redirects. */
  private async send(method: string, endpoint: string, authorization: string, body?: string, callerGone?: AbortSignal): Promise<Uint8Array> {
    const signal = AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(callerGone === undefined ? [] : [callerGone])]);
    // Not hearing back is the gateway's fault, unless the caller left first.
    const noAnswer = (cause: unknown): Error => (callerGone?.aborted === true ? new CallerGone() : gatewayDidNotAnswer(method, endpoint, cause));

    const first = resolveReference(null, this.base + endpoint);
    if (first === null) {
      // A gateway address that is no URL: Go's NewRequest fails, and the caller gets a 502.
      throw new UpstreamError(502, "st-gateway address is not a usable URL", `${method} ${endpoint}`);
    }
    let target = first;
    let verb = method;
    let payload = body;
    // Once a hop has left the original host's domain Authorization stays off, also if a later hop comes back (Go 1.24).
    let stripped = false;
    let res: globalThis.Response;
    for (let requests = 1; ; requests++) {
      const headers: Record<string, string> = {};
      // Go sends the header when the caller's is non-empty, and only then.
      if (authorization !== "" && !stripped) headers["Authorization"] = authorization;
      if (payload !== undefined) headers["Content-Type"] = "application/json";
      try {
        res = await this.fetchImpl(target.url, { method: verb, headers, ...(payload !== undefined ? { body: payload } : {}), redirect: "manual", signal });
      } catch (err) {
        throw noAnswer(err);
      }
      const location = res.headers.get("Location") ?? "";
      if (!FOLLOWED.has(res.status) || location === "") break;
      await res.body?.cancel().catch(() => undefined);
      const next = resolveReference(target, location);
      if (next === null) throw noAnswer(new Error("failed to parse Location header"));
      if (requests >= MAX_REQUESTS) throw noAnswer(new Error(`stopped after ${MAX_REQUESTS} redirects`));
      if (!stripped && next.host !== first.host && !isDomainOrSubdomain(hostnameOf(next.host), hostnameOf(first.host))) stripped = true;
      target = next;
      if (res.status <= 303 && verb !== "GET" && verb !== "HEAD") verb = "GET";
      if (res.status <= 303) payload = undefined;
    }

    if (res.status >= 400) throw await upstreamErrorFrom(res, method, endpoint);
    try {
      return new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      // The body died mid-read: the answer never arrived.
      throw noAnswer(err);
    }
  }
}
