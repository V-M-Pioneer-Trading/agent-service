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
 *    the same host or a subdomain of it; a redirect without a Location is the
 *    answer itself; fetch's own `redirect: "follow"` would stop at twenty and
 *    strip Authorization on any change of origin;
 *  - one 30 s deadline covers every hop and the reading of the body;
 *  - a status of 400 or more is the gateway's verdict (errors.ts), anything
 *    else is read whole and decoded (decode.ts).
 *
 * Failures are thrown: an UpstreamError (504: no answer; the gateway's own
 * status), or an UnreadableAnswer (502). The app's error handler relays them.
 */

import { decode, DecodeError, type Decoded, type Schema } from "./decode";
import { gatewayDidNotAnswer, REQUEST_TIMEOUT_MS, UnreadableAnswer, UpstreamError, upstreamErrorFrom } from "./errors";
import { getMyAgentResponse, getMyContractResponse, getMyContractsResponse, getMyShipResponse, getMyShipsResponse, type Agent, type Contract, type Ship } from "./schema";
import { pathEscape } from "../http/muxCompat";

/** Go's http.Client stops after ten requests. */
export const MAX_REQUESTS = 10;
const FOLLOWED = new Set([301, 302, 303, 307, 308]);

/** Go's isDomainOrSubdomain. */
const isDomainOrSubdomain = (sub: string, parent: string): boolean => sub === parent || (sub.endsWith(parent) && sub[sub.length - parent.length - 1] === ".");

export class GatewayClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  /** `proxyUrl` is ST_GATEWAY_URL with its trailing slashes trimmed and "/proxy" appended (config.ts). */
  constructor(proxyUrl: string, fetchImpl: typeof fetch = fetch) {
    this.base = proxyUrl;
    this.fetchImpl = fetchImpl;
  }

  async getMyAgent(authorization: string): Promise<Agent> {
    return (await this.request("GET", "/my/agent", authorization, getMyAgentResponse)).data;
  }

  async getMyShips(authorization: string): Promise<Ship[] | null> {
    return (await this.request("GET", "/my/ships", authorization, getMyShipsResponse)).data;
  }

  /** `symbol` is the path segment as the router decoded it: bytes, not necessarily UTF-8. */
  async getMyShip(authorization: string, symbol: Uint8Array): Promise<Ship> {
    return (await this.request("GET", `/my/ships/${pathEscape(symbol)}`, authorization, getMyShipResponse)).data;
  }

  async getMyContracts(authorization: string): Promise<Contract[] | null> {
    return (await this.request("GET", "/my/contracts", authorization, getMyContractsResponse)).data;
  }

  async getMyContract(authorization: string, id: Uint8Array): Promise<Contract> {
    return (await this.request("GET", `/my/contracts/${pathEscape(id)}`, authorization, getMyContractResponse)).data;
  }

  /** One call through st-gateway, its 2xx body decoded into `schema`. */
  private async request<S extends Schema>(method: string, endpoint: string, authorization: string, schema: S, body?: string): Promise<Decoded<S>> {
    const answer = await this.send(method, endpoint, authorization, body);
    try {
      return decode(schema, answer);
    } catch (err) {
      if (err instanceof DecodeError) throw new UnreadableAnswer(err.message);
      throw err;
    }
  }

  /** The body of the final non-error answer, after redirects. */
  private async send(method: string, endpoint: string, authorization: string, body?: string): Promise<Uint8Array> {
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let first: URL;
    try {
      first = new URL(this.base + endpoint);
    } catch (err) {
      // A gateway address that is no URL: Go's NewRequest fails, and the caller gets a 502.
      throw new UpstreamError(502, "st-gateway address is not a usable URL", `${method} ${endpoint}`, {}, { cause: err });
    }
    let url = first;
    let verb = method;
    let payload = body;
    let res: globalThis.Response;
    for (let requests = 1; ; requests++) {
      const headers: Record<string, string> = {};
      // Go sends the header when the caller's is non-empty, and only then.
      if (authorization !== "" && isDomainOrSubdomain(url.hostname, first.hostname)) headers["Authorization"] = authorization;
      if (payload !== undefined) headers["Content-Type"] = "application/json";
      try {
        res = await this.fetchImpl(url, { method: verb, headers, ...(payload !== undefined ? { body: payload } : {}), redirect: "manual", signal });
      } catch (err) {
        throw gatewayDidNotAnswer(method, endpoint, err);
      }
      const location = res.headers.get("Location") ?? "";
      if (!FOLLOWED.has(res.status) || location === "") break;
      await res.body?.cancel().catch(() => undefined);
      try {
        url = new URL(location, url);
      } catch (err) {
        throw gatewayDidNotAnswer(method, endpoint, err);
      }
      if (requests >= MAX_REQUESTS) throw gatewayDidNotAnswer(method, endpoint, new Error(`stopped after ${MAX_REQUESTS} redirects`));
      if (res.status <= 303 && verb !== "GET" && verb !== "HEAD") verb = "GET";
      if (res.status <= 303) payload = undefined;
    }

    if (res.status >= 400) throw await upstreamErrorFrom(res, method, endpoint);
    try {
      return new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      // The body died mid-read: the answer never arrived.
      throw gatewayDidNotAnswer(method, endpoint, err);
    }
  }
}
