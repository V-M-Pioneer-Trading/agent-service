// What st-gateway answers with, and what the service is expected to turn it into.
//
// The service does not pass the gateway's JSON through: it decodes it into typed
// structures and encodes those again. Every payload below therefore comes in two
// halves, the object a stub sends and the object a caller must receive, and the
// quirks of the round trip (zero values, null slices, dropped members, normalised
// timestamps) are what the shapes suite pins.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Go's zero time.Time, as it marshals. */
export const ZERO_TIME = '0001-01-01T00:00:00Z';

export function agent(symbol = 'CONTRACT-AGENT'): Record<string, Json> {
  return {
    accountId: 'acct-1',
    symbol,
    headquarters: 'X1-AB12-A1',
    credits: 175000,
    startingFaction: 'COSMIC',
    shipCount: 2,
  };
}

const requirements = { power: 1, crew: 2, slots: 3 };

export function ship(symbol: string): Record<string, Json> {
  return {
    symbol,
    registration: { name: symbol, factionSymbol: 'COSMIC', role: 'COMMAND' },
    nav: {
      systemSymbol: 'X1-AB12',
      waypointSymbol: 'X1-AB12-A1',
      route: {
        destination: { symbol: 'X1-AB12-A1', type: 'PLANET', systemSymbol: 'X1-AB12', x: 10, y: -20 },
        origin: { symbol: 'X1-AB12-B2', type: 'MOON', systemSymbol: 'X1-AB12', x: -3, y: 4 },
        departureTime: '2026-01-02T03:04:05Z',
        arrival: '2026-01-02T03:14:05Z',
      },
      status: 'IN_TRANSIT',
      flightMode: 'CRUISE',
    },
    crew: { current: 5, required: 4, capacity: 8, rotation: 'STRICT', morale: 100, wages: 7 },
    frame: {
      symbol: 'FRAME_FRIGATE',
      name: 'Frame Frigate',
      description: 'A frame',
      condition: 100,
      integrity: 99,
      moduleSlots: 8,
      mountingPoints: 5,
      fuelCapacity: 1200,
      requirements,
    },
    reactor: {
      symbol: 'REACTOR_FISSION_I',
      name: 'Fission Reactor',
      description: 'A reactor',
      condition: 98,
      integrity: 97,
      powerOutput: 31,
      requirements,
    },
    engine: {
      symbol: 'ENGINE_ION_DRIVE_II',
      name: 'Ion Drive',
      description: 'An engine',
      condition: 96,
      integrity: 95,
      speed: 30,
      requirements,
    },
    cooldown: {
      shipSymbol: symbol,
      totalSeconds: 70,
      remainingSeconds: 12,
      expiration: '2026-01-02T03:05:17Z',
    },
    modules: [
      { symbol: 'MODULE_CARGO_HOLD_I', capacity: 30, range: 0, name: 'Cargo Hold', description: 'A hold', requirements },
    ],
    mounts: [
      {
        symbol: 'MOUNT_MINING_LASER_I',
        name: 'Mining Laser',
        description: 'A laser',
        strength: 10,
        deposits: ['IRON_ORE', 'COPPER_ORE'],
        requirements,
      },
    ],
    cargo: {
      capacity: 40,
      units: 3,
      inventory: [{ symbol: 'IRON_ORE', name: 'Iron Ore', description: 'Ore', units: 3 }],
    },
    fuel: { current: 900, capacity: 1200, consumed: { amount: 17, timestamp: '2026-01-02T03:04:05Z' } },
  };
}

export function contract(id: string): Record<string, Json> {
  return {
    id,
    factionSymbol: 'COSMIC',
    type: 'PROCUREMENT',
    terms: {
      deadline: '2026-02-01T00:00:00Z',
      payment: { onAccepted: 1000, onFulfilled: 5000 },
      deliver: [
        { tradeSymbol: 'IRON_ORE', destinationSymbol: 'X1-AB12-A1', unitsRequired: 100, unitsFulfilled: 10 },
      ],
    },
    accepted: true,
    fulfilled: false,
    expiration: '2026-03-01T00:00:00Z',
    deadlineToAccept: '2026-01-15T00:00:00Z',
  };
}

export function marketTransaction(
  shipSymbol: string,
  tradeSymbol: string,
  type: 'PURCHASE' | 'SELL',
  timestamp: string,
  overrides: Record<string, Json> = {},
): Record<string, Json> {
  return {
    waypointSymbol: 'X1-AB12-A1',
    shipSymbol,
    tradeSymbol,
    type,
    units: 4,
    pricePerUnit: 25,
    totalPrice: 100,
    timestamp,
    ...overrides,
  };
}

export function marketResult(
  shipSymbol: string,
  tradeSymbol: string,
  type: 'PURCHASE' | 'SELL',
  timestamp: string,
  txOverrides: Record<string, Json> = {},
  credits = 175100,
): Record<string, Json> {
  return {
    agent: { ...agent(), credits },
    cargo: { capacity: 40, units: 7, inventory: [{ symbol: tradeSymbol, name: 'Good', description: 'A good', units: 7 }] },
    transaction: marketTransaction(shipSymbol, tradeSymbol, type, timestamp, txOverrides),
  };
}

export function purchaseShipResult(shipSymbol: string, shipType: string, timestamp: string): Record<string, Json> {
  return {
    agent: { ...agent(), credits: 120000, shipCount: 3 },
    ship: ship(shipSymbol),
    transaction: {
      waypointSymbol: 'X1-AB12-C3',
      shipType,
      price: 55000,
      agentSymbol: 'CONTRACT-AGENT',
      timestamp,
    },
  };
}

export function contractAndAgent(id: string, accepted: boolean): Record<string, Json> {
  return { agent: agent(), contract: { ...contract(id), accepted } };
}

/** Envelope SpaceTraders wraps every answer in. */
export function data(value: Json): Record<string, Json> {
  return { data: value };
}

export function listOf(values: Json[]): Record<string, Json> {
  return { data: values, meta: { total: values.length, page: 1, limit: 10 } };
}

// ---------------------------------------------------------------- zero values

export const zeroAgent: Record<string, Json> = {
  accountId: '',
  symbol: '',
  headquarters: '',
  credits: 0,
  startingFaction: '',
  shipCount: 0,
};

const zeroRequirements = { power: 0, crew: 0, slots: 0 };

const zeroWaypoint = { symbol: '', type: '', systemSymbol: '', x: 0, y: 0 };

/** A ship with every member missing: what Go encodes for the zero Ship. */
export const zeroShip: Record<string, Json> = {
  symbol: '',
  registration: { name: '', factionSymbol: '', role: '' },
  nav: {
    systemSymbol: '',
    waypointSymbol: '',
    route: { destination: zeroWaypoint, origin: zeroWaypoint, departureTime: ZERO_TIME, arrival: ZERO_TIME },
    status: '',
    flightMode: '',
  },
  crew: { current: 0, required: 0, capacity: 0, rotation: '', morale: 0, wages: 0 },
  frame: {
    symbol: '',
    name: '',
    description: '',
    condition: 0,
    integrity: 0,
    moduleSlots: 0,
    mountingPoints: 0,
    fuelCapacity: 0,
    requirements: zeroRequirements,
  },
  reactor: {
    symbol: '',
    name: '',
    description: '',
    condition: 0,
    integrity: 0,
    powerOutput: 0,
    requirements: zeroRequirements,
  },
  engine: {
    symbol: '',
    name: '',
    description: '',
    condition: 0,
    integrity: 0,
    speed: 0,
    requirements: zeroRequirements,
  },
  cooldown: { shipSymbol: '', totalSeconds: 0, remainingSeconds: 0, expiration: ZERO_TIME },
  modules: null,
  mounts: null,
  cargo: { capacity: 0, units: 0, inventory: null },
  fuel: { current: 0, capacity: 0, consumed: { amount: 0, timestamp: ZERO_TIME } },
};

export const zeroContract: Record<string, Json> = {
  id: '',
  factionSymbol: '',
  type: '',
  terms: { deadline: ZERO_TIME, payment: { onAccepted: 0, onFulfilled: 0 }, deliver: null },
  accepted: false,
  fulfilled: false,
  expiration: ZERO_TIME,
  deadlineToAccept: ZERO_TIME,
};

/** Deep-set helper so a test can say "the same ship, but with this one member changed". */
export function withPath(base: Record<string, Json>, path: string[], value: Json): Record<string, Json> {
  const copy = structuredClone(base);
  let cursor: Record<string, Json> = copy;
  for (const key of path.slice(0, -1)) cursor = cursor[key] as Record<string, Json>;
  cursor[path[path.length - 1] as string] = value;
  return copy;
}
