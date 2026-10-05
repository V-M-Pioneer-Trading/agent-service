/**
 * @file What each route requires of a caller, in one table, and the registrar
 * that turns the table into clerk-client declarations.
 *
 * Mirrors SetUpRouter in the Go service: read it as the authorization policy.
 * Tiers: "ignore" (health, docs: header never read, centre never asked),
 * "none" (public reads: a presented token is still verified), "session" (any
 * verified session) or a scope string (session carrying it).
 *
 * Verification is auth-service's; nothing here verifies a token (decision 21).
 */

import type { ExpressAuth } from "@v-m-pioneer-trading/clerk-client";

export const SCOPE_FLEET_CONTROL = "fleet:control";

// "ignore", "none" or "session", or a scope name (clerk-client's declaration vocabulary); a plain string, so no member of the union is redundant.
export type Tier = string;
export type Policy = Readonly<Record<string, Tier>>;

/** Keyed "METHOD /path" exactly as tsoa registers it (Express syntax). */
export const routePolicy: Policy = {
  "GET /health": "ignore",
  "GET /api/agent/health": "ignore",
  // The live reads: a verified session, no particular scope (decision 18).
  "GET /api/agent/v1/current-agent": "session",
  "GET /api/agent/v1/agent": "session",
  "GET /api/agent/v1/ships": "session",
  "GET /api/agent/v1/ships/:shipSymbol": "session",
  "GET /api/agent/v1/contracts": "session",
  "GET /api/agent/v1/contracts/:contractId": "session",
  // The writes: they additionally need fleet:control, same as fleet-service. Recording a delivery
  // included (meta#71).
  "POST /api/agent/v1/contracts/:contractId/accept": SCOPE_FLEET_CONTROL,
  "POST /api/agent/v1/contracts/:contractId/fulfill": SCOPE_FLEET_CONTROL,
  "POST /api/agent/v1/ships/purchase": SCOPE_FLEET_CONTROL,
  "POST /api/agent/v1/ships/:shipSymbol/purchase": SCOPE_FLEET_CONTROL,
  "POST /api/agent/v1/ships/:shipSymbol/sell": SCOPE_FLEET_CONTROL,
  "POST /api/agent/v1/contracts/:contractId/deliveries": SCOPE_FLEET_CONTROL,
  // The reads served entirely from this service's own MySQL history: a visitor with no header is
  // served; a presented token is still verified, and a bad one is a 401, never a visitor.
  "GET /api/agent/v1/contracts/:contractId/deliveries": "none",
  "GET /api/agent/v1/transactions": "none",
};

export type Registrar = Record<string, unknown>;
const VERBS = ["get", "post", "put", "patch", "delete", "head", "options"] as const;
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * A router-shaped object for tsoa's generated RegisterRoutes: every route it
 * registers gets the declaration its policy entry names as first handler. A
 * route with no entry throws, so the process refuses to start; a "none" or
 * "ignore" entry on a mutating method throws too.
 *
 * `target` is secured() as well (server.ts): the second, independent guard for
 * anything registered on it directly.
 */
export function declaring(target: Registrar, auth: ExpressAuth, policy: Policy = routePolicy): Registrar {
  const out: Registrar = {};
  for (const verb of VERBS) {
    out[verb] = (path: string, ...handlers: unknown[]) => {
      const method = verb.toUpperCase();
      const tier = policy[`${method} ${path}`];
      if (tier === undefined) {
        throw new Error(`refusing to start: route ${method} ${path} declares no credential requirement (add it to routePolicy in auth.ts)`);
      }
      if ((tier === "ignore" || tier === "none") && !SAFE.has(method)) {
        throw new Error(`refusing to start: route ${method} ${path} answers a mutating method but declares no session or scope`);
      }
      const declaration =
        tier === "ignore" ? auth.ignoreCredentials()
        : tier === "none" ? auth.allowPublic()
        : tier === "session" ? auth.requireSession()
        : auth.requireScope(tier);
      return (target[verb] as (...a: unknown[]) => unknown)(path, declaration, ...handlers);
    };
  }
  return out;
}
