// The vendored fixture is a pinned, verbatim copy. These tests touch no service.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const fixtures = new URL('../fixtures/', import.meta.url);

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function pinnedSha(): string {
  const source = readFileSync(new URL('SOURCE.txt', fixtures), 'utf8');
  const m = /^\s*sha256:\s*([0-9a-f]{64})\s*$/m.exec(source);
  assert.ok(m !== null && m[1] !== undefined, 'fixtures/SOURCE.txt records no sha256');
  return m[1];
}

describe('fixture pins', () => {
  it('gateway-errors.json matches the sha256 in fixtures/SOURCE.txt (any byte, anywhere)', () => {
    const copy = readFileSync(new URL('gateway-errors.json', fixtures));
    assert.equal(sha256(copy), pinnedSha());
  });
});
