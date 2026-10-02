// The vendored fixture is a pinned, verbatim copy. These tests touch no service.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

const fixtures = new URL('../fixtures/', import.meta.url);
const original = new URL('../../src/spacetraders/testdata/gateway-errors.json', import.meta.url);

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function lf(bytes: Buffer): Buffer {
  return Buffer.from(bytes.toString('utf8').replaceAll('\r\n', '\n'), 'utf8');
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

  it('gateway-errors.json is the same as the original it was copied from', (t) => {
    if (!existsSync(original)) {
      t.skip('the original (src/spacetraders/testdata/gateway-errors.json) is not in this checkout');
      return;
    }
    // Compared as LF bytes: a Windows checkout of the original may carry CRLF.
    assert.equal(sha256(lf(readFileSync(original))), pinnedSha());
  });
});
