// The one shared fixture of the run: two stubs and the service under test. It is
// filled in by the root hooks in contract.test.ts; suites only read it, inside
// their tests.

import { CenterStub, GatewayStub } from './stubs.ts';
import type { CenterBehaviour } from './stubs.ts';
import { send } from './http.ts';
import type { Req, Res } from './http.ts';
import type { RunningService } from './service.ts';

export const gateway = new GatewayStub();
export const center = new CenterStub();

export const world: { service: RunningService | undefined } = { service: undefined };

export function baseUrl(): string {
  if (world.service === undefined) throw new Error('the service is not running');
  return world.service.baseUrl;
}

/** Send a request to the service under test. */
export function call(req: Req): Promise<Res> {
  return send(baseUrl(), req);
}

export const API = '/api/agent/v1';

// ------------------------------------------------------------------ identity

/** A session with no scopes, the lowest credential the read tier accepts. */
export function readerToken(): string {
  return center.token({ kind: 'active' }, 'reader');
}

/** A session carrying fleet:control, what every mutation needs. */
export function writerToken(): string {
  return center.token({ kind: 'active', scope: 'fleet:control' }, 'writer');
}

export function tokenFor(behaviour: CenterBehaviour, label?: string): string {
  return center.token(behaviour, label);
}

export function bearer(token: string): string {
  return `Bearer ${token}`;
}

// ------------------------------------------------------------ unique symbols

const runId = Math.random().toString(36).slice(2, 8).toUpperCase();
let counter = 0;

/**
 * A symbol no other test (and no earlier run against the same database) uses.
 * At most 24 characters, well inside the 64 the columns hold.
 */
export function uid(prefix: string): string {
  return `${prefix}-${runId}-${++counter}`;
}

export function runTag(): string {
  return runId;
}
