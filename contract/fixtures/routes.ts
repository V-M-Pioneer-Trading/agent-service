// The route table of src/api/routes.go, restated for black-box use: for each
// route, a valid request, the upstream calls it makes, and the 200 answer a
// caller must receive when the gateway answers as scripted.

import type { GatewayReply } from '../harness/stubs.ts';
import { API } from '../harness/world.ts';
import * as p from './payloads.ts';
import type { Json } from './payloads.ts';

export type Tier = 'read' | 'write' | 'public' | 'ignore';

export interface UpstreamCall {
  method: string;
  /** The request target the gateway must receive. */
  target: string;
  reply: GatewayReply;
}

export interface Route {
  id: string;
  tier: Tier;
  method: 'GET' | 'POST';
  path: string;
  /** A valid request body, for routes that take one. */
  body?: Json;
  /** The gateway calls this route makes, in order. */
  upstream: UpstreamCall[];
  /** The body of a 200 answer, when the gateway answers as scripted. */
  expected?: Json;
}

export const TS_PURCHASE = '2026-03-04T05:06:07Z';

/** The routes that call st-gateway, built for one unique symbol. */
export function upstreamRoutes(sym: string): Route[] {
  const ship = p.ship(sym);
  const contract = p.contract(sym);
  return [
    {
      id: 'GET /agent',
      tier: 'read',
      method: 'GET',
      path: `${API}/agent`,
      upstream: [{ method: 'GET', target: '/proxy/my/agent', reply: { json: p.data(p.agent()) } }],
      expected: p.agent(),
    },
    {
      id: 'GET /ships',
      tier: 'read',
      method: 'GET',
      path: `${API}/ships`,
      upstream: [{ method: 'GET', target: '/proxy/my/ships', reply: { json: p.listOf([ship]) } }],
      expected: [ship],
    },
    {
      id: 'GET /ships/{shipSymbol}',
      tier: 'read',
      method: 'GET',
      path: `${API}/ships/${sym}`,
      upstream: [{ method: 'GET', target: `/proxy/my/ships/${sym}`, reply: { json: p.data(ship) } }],
      expected: ship,
    },
    {
      id: 'GET /contracts',
      tier: 'read',
      method: 'GET',
      path: `${API}/contracts`,
      upstream: [{ method: 'GET', target: '/proxy/my/contracts', reply: { json: p.listOf([contract]) } }],
      expected: [contract],
    },
    {
      id: 'GET /contracts/{contractId}',
      tier: 'read',
      method: 'GET',
      path: `${API}/contracts/${sym}`,
      upstream: [{ method: 'GET', target: `/proxy/my/contracts/${sym}`, reply: { json: p.data(contract) } }],
      expected: contract,
    },
    {
      id: 'GET /current-agent',
      tier: 'read',
      method: 'GET',
      path: `${API}/current-agent`,
      upstream: [
        { method: 'GET', target: '/proxy/my/agent', reply: { json: p.data(p.agent()) } },
        { method: 'GET', target: '/proxy/my/ships', reply: { json: p.listOf([ship]) } },
        { method: 'GET', target: '/proxy/my/contracts', reply: { json: p.listOf([contract]) } },
      ],
      expected: { agent: p.agent(), ships: [ship], contracts: [contract] },
    },
    {
      id: 'POST /contracts/{contractId}/accept',
      tier: 'write',
      method: 'POST',
      path: `${API}/contracts/${sym}/accept`,
      upstream: [
        { method: 'POST', target: `/proxy/my/contracts/${sym}/accept`, reply: { json: p.data(p.contractAndAgent(sym, true)) } },
      ],
      expected: p.contractAndAgent(sym, true),
    },
    {
      id: 'POST /contracts/{contractId}/fulfill',
      tier: 'write',
      method: 'POST',
      path: `${API}/contracts/${sym}/fulfill`,
      upstream: [
        { method: 'POST', target: `/proxy/my/contracts/${sym}/fulfill`, reply: { json: p.data(p.contractAndAgent(sym, true)) } },
      ],
      expected: p.contractAndAgent(sym, true),
    },
    {
      id: 'POST /ships/purchase',
      tier: 'write',
      method: 'POST',
      path: `${API}/ships/purchase`,
      body: { shipType: 'SHIP_MINING_DRONE', waypointSymbol: 'X1-AB12-C3' },
      upstream: [
        {
          method: 'POST',
          target: '/proxy/my/ships',
          reply: { json: p.data(p.purchaseShipResult(sym, 'SHIP_MINING_DRONE', TS_PURCHASE)) },
        },
      ],
      expected: p.purchaseShipResult(sym, 'SHIP_MINING_DRONE', TS_PURCHASE),
    },
    {
      id: 'POST /ships/{shipSymbol}/purchase',
      tier: 'write',
      method: 'POST',
      path: `${API}/ships/${sym}/purchase`,
      body: { symbol: 'IRON_ORE', units: 4 },
      upstream: [
        {
          method: 'POST',
          target: `/proxy/my/ships/${sym}/purchase`,
          reply: { json: p.data(p.marketResult(sym, 'IRON_ORE', 'PURCHASE', TS_PURCHASE)) },
        },
      ],
      expected: p.marketResult(sym, 'IRON_ORE', 'PURCHASE', TS_PURCHASE),
    },
    {
      id: 'POST /ships/{shipSymbol}/sell',
      tier: 'write',
      method: 'POST',
      path: `${API}/ships/${sym}/sell`,
      body: { symbol: 'IRON_ORE', units: 4 },
      upstream: [
        {
          method: 'POST',
          target: `/proxy/my/ships/${sym}/sell`,
          reply: { json: p.data(p.marketResult(sym, 'IRON_ORE', 'SELL', TS_PURCHASE)) },
        },
      ],
      expected: p.marketResult(sym, 'IRON_ORE', 'SELL', TS_PURCHASE),
    },
  ];
}

/** Every route of the service that is not an upstream proxy. */
export function localRoutes(sym: string): Route[] {
  return [
    {
      id: 'POST /contracts/{contractId}/deliveries',
      tier: 'write',
      method: 'POST',
      path: `${API}/contracts/${sym}/deliveries`,
      body: { shipSymbol: 'SHIP-1', tradeSymbol: 'IRON_ORE', units: 5 },
      upstream: [],
    },
    { id: 'GET /contracts/{contractId}/deliveries', tier: 'public', method: 'GET', path: `${API}/contracts/${sym}/deliveries`, upstream: [] },
    { id: 'GET /transactions', tier: 'public', method: 'GET', path: `${API}/transactions?shipSymbol=${sym}`, upstream: [] },
    { id: 'GET /health', tier: 'ignore', method: 'GET', path: '/health', upstream: [] },
    { id: 'GET /api/agent/health', tier: 'ignore', method: 'GET', path: '/api/agent/health', upstream: [] },
    { id: 'GET /api/agent/swagger/', tier: 'ignore', method: 'GET', path: '/api/agent/swagger/', upstream: [] },
  ];
}

export function allRoutes(sym: string): Route[] {
  return [...upstreamRoutes(sym), ...localRoutes(sym)];
}

/** Script every upstream call of a route onto the gateway stub. */
export function scriptUpstream(gateway: { on(method: string, target: string, ...replies: GatewayReply[]): void }, route: Route): void {
  for (const call of route.upstream) gateway.on(call.method, call.target, call.reply);
}

export const JSON_HEADERS = { 'Content-Type': 'application/json' };
