/**
 * @file The shapes the live read routes answer with, as the OpenAPI spec
 * describes them. They mirror gateway/schema.ts member for member (the
 * assertion at the bottom fails the build if they drift): a SpaceTraders
 * answer is decoded into those structures and written back, so this is what
 * a caller sees.
 *
 * Every integer is an int64 (`@isLong`). In memory it is a bigint, because a
 * JavaScript number loses what is above 2^53; the answer is written with the
 * exact digits (gateway/json.ts). Times are RFC 3339 text.
 */

import type { Delivery as StoredDelivery, Transaction as StoredTransaction, TransactionType as StoredTransactionType } from "../db/history";
import type {
  Agent as DecodedAgent,
  Contract as DecodedContract,
  ContractAndAgent as DecodedContractAndAgent,
  MarketTransactionResult as DecodedMarketTransactionResult,
  PurchaseShipResult as DecodedPurchaseShipResult,
  Ship as DecodedShip,
} from "../gateway/schema";

/** The agent's profile. */
export interface Agent {
  accountId: string;
  symbol: string;
  headquarters: string;
  /** @isLong */
  credits: number;
  startingFaction: string;
  /** @isLong */
  shipCount: number;
}

export interface Requirements {
  /** @isLong */
  power: number;
  /** @isLong */
  crew: number;
  /** @isLong */
  slots: number;
}

export interface ShipRegistration {
  name: string;
  factionSymbol: string;
  role: string;
}

export interface RouteWaypoint {
  symbol: string;
  type: string;
  systemSymbol: string;
  /** @isLong */
  x: number;
  /** @isLong */
  y: number;
}

export interface ShipRoute {
  destination: RouteWaypoint;
  origin: RouteWaypoint;
  /** RFC 3339 */
  departureTime: string;
  /** RFC 3339 */
  arrival: string;
}

export interface ShipNav {
  systemSymbol: string;
  waypointSymbol: string;
  route: ShipRoute;
  status: string;
  flightMode: string;
}

export interface ShipCrew {
  /** @isLong */
  current: number;
  /** @isLong */
  required: number;
  /** @isLong */
  capacity: number;
  rotation: string;
  /** @isLong */
  morale: number;
  /** @isLong */
  wages: number;
}

export interface ShipFrame {
  symbol: string;
  name: string;
  description: string;
  /** @isLong */
  condition: number;
  /** @isLong */
  integrity: number;
  /** @isLong */
  moduleSlots: number;
  /** @isLong */
  mountingPoints: number;
  /** @isLong */
  fuelCapacity: number;
  requirements: Requirements;
}

export interface ShipReactor {
  symbol: string;
  name: string;
  description: string;
  /** @isLong */
  condition: number;
  /** @isLong */
  integrity: number;
  /** @isLong */
  powerOutput: number;
  requirements: Requirements;
}

export interface ShipEngine {
  symbol: string;
  name: string;
  description: string;
  /** @isLong */
  condition: number;
  /** @isLong */
  integrity: number;
  /** @isLong */
  speed: number;
  requirements: Requirements;
}

export interface ShipCooldown {
  shipSymbol: string;
  /** @isLong */
  totalSeconds: number;
  /** @isLong */
  remainingSeconds: number;
  /** RFC 3339 */
  expiration: string;
}

export interface ShipModule {
  symbol: string;
  /** @isLong */
  capacity: number;
  /** @isLong */
  range: number;
  name: string;
  description: string;
  requirements: Requirements;
}

export interface ShipMount {
  symbol: string;
  name: string;
  description: string;
  /** @isLong */
  strength: number;
  deposits: string[] | null;
  requirements: Requirements;
}

export interface CargoItem {
  symbol: string;
  name: string;
  description: string;
  /** @isLong */
  units: number;
}

export interface ShipCargo {
  /** @isLong */
  capacity: number;
  /** @isLong */
  units: number;
  inventory: CargoItem[] | null;
}

export interface ShipFuelConsumed {
  /** @isLong */
  amount: number;
  /** RFC 3339 */
  timestamp: string;
}

export interface ShipFuel {
  /** @isLong */
  current: number;
  /** @isLong */
  capacity: number;
  consumed: ShipFuelConsumed;
}

/** A ship. A list the gateway did not send is null. */
export interface Ship {
  symbol: string;
  registration: ShipRegistration;
  nav: ShipNav;
  crew: ShipCrew;
  frame: ShipFrame;
  reactor: ShipReactor;
  engine: ShipEngine;
  cooldown: ShipCooldown;
  modules: ShipModule[] | null;
  mounts: ShipMount[] | null;
  cargo: ShipCargo;
  fuel: ShipFuel;
}

export interface ContractPayment {
  /** @isLong */
  onAccepted: number;
  /** @isLong */
  onFulfilled: number;
}

export interface ContractDeliverGood {
  tradeSymbol: string;
  destinationSymbol: string;
  /** @isLong */
  unitsRequired: number;
  /** @isLong */
  unitsFulfilled: number;
}

export interface ContractTerms {
  /** RFC 3339 */
  deadline: string;
  payment: ContractPayment;
  deliver: ContractDeliverGood[] | null;
}

export interface Contract {
  id: string;
  factionSymbol: string;
  type: string;
  terms: ContractTerms;
  accepted: boolean;
  fulfilled: boolean;
  /** RFC 3339 */
  expiration: string;
  /** RFC 3339 */
  deadlineToAccept: string;
}

/** Agent, ships and contracts in one answer. */
export interface CurrentAgent {
  agent: Agent;
  ships: Ship[] | null;
  contracts: Contract[] | null;
}

/** accept-contract and fulfill-contract answer the same shape. */
export interface ContractAndAgent {
  agent: Agent;
  contract: Contract;
}

export interface ShipyardTransaction {
  waypointSymbol: string;
  shipType: string;
  /** @isLong */
  price: number;
  agentSymbol: string;
  /** RFC 3339 */
  timestamp: string;
}

export interface MarketTransaction {
  waypointSymbol: string;
  shipSymbol: string;
  tradeSymbol: string;
  type: string;
  /** @isLong */
  units: number;
  /** @isLong */
  pricePerUnit: number;
  /** @isLong */
  totalPrice: number;
  /** RFC 3339 */
  timestamp: string;
}

/** The new ship, what it cost and what the agent has left. */
export interface PurchaseShipResult {
  agent: Agent;
  ship: Ship;
  transaction: ShipyardTransaction;
}

/** purchase-cargo and sell-cargo answer the same shape. */
export interface MarketTransactionResult {
  agent: Agent;
  cargo: ShipCargo;
  transaction: MarketTransaction;
}

// --- request bodies, as documented. They are read by the handlers themselves, with the rules of
// Go's json.Decoder (gateway/decode.ts), and never by tsoa: see the routes' comments.

/** What fleet-service reports after a successful deliver-contract. */
export interface DeliveryRequest {
  shipSymbol: string;
  tradeSymbol: string;
  /** @isLong */
  units: number;
}

export interface PurchaseShipRequest {
  shipType: string;
  waypointSymbol: string;
}

export interface CargoTransactionRequest {
  /** The trade good's symbol. */
  symbol: string;
  /** @isLong */
  units: number;
}

// --- what the history answers with

/** One delivery against a contract, as recorded. */
export interface Delivery {
  contractId: string;
  shipSymbol: string;
  tradeSymbol: string;
  /** @isLong */
  units: number;
  /** RFC 3339, UTC */
  deliveredAt: string;
}

export type TransactionType = "SHIP_PURCHASE" | "PURCHASE" | "SELL";

/** One ship purchase, cargo purchase or cargo sale. A member the row has no value for is absent. */
export interface Transaction {
  type: TransactionType;
  shipSymbol: string;
  waypointSymbol: string;
  shipType?: string;
  tradeSymbol?: string;
  /** @isLong */
  units?: number;
  /** @isLong */
  pricePerUnit?: number;
  /** @isLong */
  totalPrice: number;
  /** @isLong */
  agentCredits: number;
  /** RFC 3339, UTC, to the second */
  occurredAt: string;
}

// --- the models and the decoder describe the same thing -----------------------

type Wire<T> = T extends bigint ? number : T extends (infer E)[] ? Wire<E>[] : T extends object ? { [K in keyof T]: Wire<T[K]> } : T;
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the standard type-equality check: each T has to be a distinct generic for the two function types to be compared
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

export type ModelsMatchTheDecoder = [
  Assert<Same<Wire<DecodedAgent>, Wire<Agent>>>,
  Assert<Same<Wire<DecodedShip>, Wire<Ship>>>,
  Assert<Same<Wire<DecodedContract>, Wire<Contract>>>,
  Assert<Same<Wire<DecodedContractAndAgent>, Wire<ContractAndAgent>>>,
  Assert<Same<Wire<DecodedPurchaseShipResult>, Wire<PurchaseShipResult>>>,
  Assert<Same<Wire<DecodedMarketTransactionResult>, Wire<MarketTransactionResult>>>,
  Assert<Same<Wire<StoredDelivery>, Wire<Delivery>>>,
  Assert<Same<Wire<StoredTransaction>, Wire<Transaction>>>,
  Assert<Same<StoredTransactionType, TransactionType>>,
];
