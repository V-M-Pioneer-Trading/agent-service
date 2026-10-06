/**
 * @file The wire types for the SpaceTraders API: the former Go service's src/spacetraders/schema/*.go (deleted in agent-service#38; see 65bb4b2),
 * member for member, in the same order (the order is the order of the answer).
 * Every Go `int` and `int64` is int64 here (bigint). The one deliberate departure: what the
 * SpaceTraders spec (SpaceTradersAPI/api-docs, models/*.json) types as `number` rather than
 * `integer` is float64 (a JavaScript number), not int64 as Go had it. That is a ship component's
 * `condition` and `integrity` (ShipComponentCondition/Integrity, 0..1) on frame, reactor and
 * engine; a worn ship's 0.999 was a 502 (agent-service#62). The write routes' results
 * (contract and agent, purchase, market transaction) are at the end.
 */

import { bool, float64, int64, list, struct, text, time, type Decoded } from "./decode";

export const agentSchema = struct({
  accountId: text,
  symbol: text,
  headquarters: text,
  credits: int64,
  startingFaction: text,
  shipCount: int64,
});

const requirements = struct({ power: int64, crew: int64, slots: int64 });
const module_ = struct({ symbol: text, capacity: int64, range: int64, name: text, description: text, requirements });
const mount = struct({ symbol: text, name: text, description: text, strength: int64, deposits: list(text), requirements });
const routeWaypoint = struct({ symbol: text, type: text, systemSymbol: text, x: int64, y: int64 });

export const cargoSchema = struct({
  capacity: int64,
  units: int64,
  inventory: list(struct({ symbol: text, name: text, description: text, units: int64 })),
});

export const shipSchema = struct({
  symbol: text,
  registration: struct({ name: text, factionSymbol: text, role: text }),
  nav: struct({
    systemSymbol: text,
    waypointSymbol: text,
    route: struct({ destination: routeWaypoint, origin: routeWaypoint, departureTime: time, arrival: time }),
    status: text,
    flightMode: text,
  }),
  crew: struct({ current: int64, required: int64, capacity: int64, rotation: text, morale: int64, wages: int64 }),
  frame: struct({
    symbol: text,
    name: text,
    description: text,
    condition: float64,
    integrity: float64,
    moduleSlots: int64,
    mountingPoints: int64,
    fuelCapacity: int64,
    requirements,
  }),
  reactor: struct({ symbol: text, name: text, description: text, condition: float64, integrity: float64, powerOutput: int64, requirements }),
  engine: struct({ symbol: text, name: text, description: text, condition: float64, integrity: float64, speed: int64, requirements }),
  cooldown: struct({ shipSymbol: text, totalSeconds: int64, remainingSeconds: int64, expiration: time }),
  modules: list(module_),
  mounts: list(mount),
  cargo: cargoSchema,
  fuel: struct({ current: int64, capacity: int64, consumed: struct({ amount: int64, timestamp: time }) }),
});

export const contractSchema = struct({
  id: text,
  factionSymbol: text,
  type: text,
  terms: struct({
    deadline: time,
    payment: struct({ onAccepted: int64, onFulfilled: int64 }),
    deliver: list(struct({ tradeSymbol: text, destinationSymbol: text, unitsRequired: int64, unitsFulfilled: int64 })),
  }),
  accepted: bool,
  fulfilled: bool,
  expiration: time,
  deadlineToAccept: time,
});

export type Agent = Decoded<typeof agentSchema>;
export type Ship = Decoded<typeof shipSchema>;
export type Contract = Decoded<typeof contractSchema>;

// The envelopes SpaceTraders wraps everything in. `meta` is decoded (a malformed one is a 502) and dropped.
const paginationMeta = struct({ total: int64, page: int64, limit: int64 });
export const getMyAgentResponse = struct({ data: agentSchema });
export const getMyShipsResponse = struct({ data: list(shipSchema), meta: paginationMeta });
export const getMyShipResponse = struct({ data: shipSchema });
export const getMyContractsResponse = struct({ data: list(contractSchema), meta: paginationMeta });
export const getMyContractResponse = struct({ data: contractSchema });

// --- the write routes' results ------------------------------------------------

/** accept-contract and fulfill-contract answer the same shape. */
export const contractAndAgentSchema = struct({ agent: agentSchema, contract: contractSchema });

const shipyardTransaction = struct({ waypointSymbol: text, shipType: text, price: int64, agentSymbol: text, timestamp: time });
const marketTransaction = struct({
  waypointSymbol: text,
  shipSymbol: text,
  tradeSymbol: text,
  type: text,
  units: int64,
  pricePerUnit: int64,
  totalPrice: int64,
  timestamp: time,
});

export const purchaseShipResultSchema = struct({ agent: agentSchema, ship: shipSchema, transaction: shipyardTransaction });
/** purchase-cargo and sell-cargo answer the same shape. */
export const marketTransactionResultSchema = struct({ agent: agentSchema, cargo: cargoSchema, transaction: marketTransaction });

export type ContractAndAgent = Decoded<typeof contractAndAgentSchema>;
export type PurchaseShipResult = Decoded<typeof purchaseShipResultSchema>;
export type MarketTransactionResult = Decoded<typeof marketTransactionResultSchema>;

export const acceptContractResponse = struct({ data: contractAndAgentSchema });
export const fulfillContractResponse = struct({ data: contractAndAgentSchema });
export const purchaseShipResponse = struct({ data: purchaseShipResultSchema });
export const marketTransactionResponse = struct({ data: marketTransactionResultSchema });

// --- request bodies (decoded with Go's json.Decoder rules: decodeFirstValue) ----

export const deliveryRequestSchema = struct({ shipSymbol: text, tradeSymbol: text, units: int64 });
export const purchaseShipRequestSchema = struct({ shipType: text, waypointSymbol: text });
export const cargoTransactionRequestSchema = struct({ symbol: text, units: int64 });
