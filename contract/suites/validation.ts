// Request bodies of the four POST routes that take one: what is rejected, with
// which sentence, and what is quietly accepted.
//
// The decoder is the standard library's JSON decoder, and its habits are part of
// the contract: it reads one value and ignores whatever follows it, matches
// member names case-insensitively, lets the last of a repeated key win, ignores
// unknown members, and treats null as "absent". Its error sentences are put in the
// 400 body verbatim ([go-text]; see the README).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { expectText } from '../harness/expect.ts';
import { API, bearer, call, gateway, uid, writerToken } from '../harness/world.ts';
import * as p from '../fixtures/payloads.ts';
import { TS_PURCHASE } from '../fixtures/routes.ts';

interface Target {
  name: string;
  /** The Go struct the body is decoded into; it appears in the type-error sentences. */
  struct: string;
  required: string;
  valid: Record<string, string | number>;
  stringKeys: string[];
  /** A path for one unique symbol, with the gateway scripted for it. */
  open(sym: string): string;
}

const targets: Target[] = [
  {
    name: 'POST /contracts/{id}/deliveries',
    struct: 'deliveryRequest',
    required: 'shipSymbol, tradeSymbol and units (>0) are required',
    valid: { shipSymbol: 'SHIP', tradeSymbol: 'IRON_ORE', units: 3 },
    stringKeys: ['shipSymbol', 'tradeSymbol'],
    open: (sym) => `${API}/contracts/${sym}/deliveries`,
  },
  {
    name: 'POST /ships/purchase',
    struct: 'purchaseShipRequest',
    required: 'shipType and waypointSymbol are required',
    valid: { shipType: 'SHIP_MINING_DRONE', waypointSymbol: 'X1-AB12-C3' },
    stringKeys: ['shipType', 'waypointSymbol'],
    open: (sym) => {
      gateway.on('POST', '/proxy/my/ships', { json: p.data(p.purchaseShipResult(sym, 'SHIP_MINING_DRONE', TS_PURCHASE)) });
      return `${API}/ships/purchase`;
    },
  },
  {
    name: 'POST /ships/{symbol}/purchase',
    struct: 'cargoTransactionRequest',
    required: 'symbol and units (>0) are required',
    valid: { symbol: 'IRON_ORE', units: 4 },
    stringKeys: ['symbol'],
    open: (sym) => {
      gateway.on('POST', `/proxy/my/ships/${sym}/purchase`, { json: p.data(p.marketResult(sym, 'IRON_ORE', 'PURCHASE', TS_PURCHASE)) });
      return `${API}/ships/${sym}/purchase`;
    },
  },
  {
    name: 'POST /ships/{symbol}/sell',
    struct: 'cargoTransactionRequest',
    required: 'symbol and units (>0) are required',
    valid: { symbol: 'IRON_ORE', units: 4 },
    stringKeys: ['symbol'],
    open: (sym) => {
      gateway.on('POST', `/proxy/my/ships/${sym}/sell`, { json: p.data(p.marketResult(sym, 'IRON_ORE', 'SELL', TS_PURCHASE)) });
      return `${API}/ships/${sym}/sell`;
    },
  },
];

function post(path: string, body: string | undefined, headers: Record<string, string> = {}) {
  return call({ method: 'POST', path, headers: { Authorization: bearer(writerToken()), ...headers }, body });
}

/** The valid body with some members replaced by raw JSON text (or removed with undefined). */
function bodyWith(valid: Record<string, string | number>, over: Record<string, string | undefined>): string {
  const members: string[] = [];
  for (const [k, v] of Object.entries(valid)) {
    const raw = k in over ? over[k] : JSON.stringify(v);
    if (raw !== undefined) members.push(`${JSON.stringify(k)}:${raw}`);
  }
  for (const [k, v] of Object.entries(over)) if (!(k in valid) && v !== undefined) members.push(`${JSON.stringify(k)}:${v}`);
  return `{${members.join(',')}}`;
}

for (const t of targets) {
  const hasUnits = 'units' in t.valid;
  const valid = JSON.stringify(t.valid);

  describe(t.name, () => {
    const reject = async (body: string | undefined, message: string, headers?: Record<string, string>) => {
      gateway.clearScripts();
      const res = await post(t.open(uid('VAL')), body, headers);
      expectText(res, 400, message);
      assert.deepEqual(
        gateway.requests.map((r) => `${r.method} ${r.url}`),
        [],
        'a rejected body never reaches the gateway',
      );
    };

    const accept = async (body: string, headers?: Record<string, string>) => {
      gateway.clearScripts();
      const res = await post(t.open(uid('VAL')), body, headers);
      assert.equal(res.status, 200, res.text);
      return res;
    };

    describe('syntax', () => {
      const syntax: Array<[name: string, body: string, message: string]> = [
        ['no body at all', '', 'EOF'],
        ['only whitespace', '  \n\t ', 'EOF'],
        ['an unterminated object', '{', 'unexpected EOF'],
        ['an unterminated member', '{"units":', 'unexpected EOF'],
        ['an unterminated string', '{"units', 'unexpected EOF'],
        ['not JSON', 'not json', "invalid character 'o' in literal null (expecting 'u')"],
        ['a truncated literal', 'nul', 'unexpected EOF'],
        ['a trailing comma', '{"units":1,}', "invalid character '}' looking for beginning of object key string"],
        ['single quotes', "{'units':1}", "invalid character '\\'' looking for beginning of object key string"],
        ['a missing colon', '{"units" 1}', "invalid character '1' after object key"],
        ['a missing comma', '{"units":1 "x":2}', "invalid character '\"' after object key:value pair"],
        ['a byte order mark', '﻿{}', "invalid character 'ï' looking for beginning of value"],
        ['a bare word', 'undefined', "invalid character 'u' looking for beginning of value"],
        ['an unquoted key', '{units:1}', "invalid character 'u' looking for beginning of object key string"],
        ['a bad escape', '{"a":"\\x"}', "invalid character 'x' in string escape code"],
        ['a raw newline in a string', '{"a":"x\ny"}', "invalid character '\\n' in string literal"],
        ['a leading zero', '{"units":01}', "invalid character '1' after object key:value pair"],
        ['a leading plus', '{"units":+1}', "invalid character '+' looking for beginning of value"],
        ['NaN', '{"units":NaN}', "invalid character 'N' looking for beginning of value"],
        ['a comment', '{/*x*/}', "invalid character '/' looking for beginning of object key string"],
      ];
      for (const [name, body, message] of syntax) {
        it(`${name}: 400 [go-text]`, async () => {
          await reject(body, `invalid request body: ${message}`);
        });
      }
    });

    describe('types [go-text]', () => {
      for (const [name, body, kind] of [
        ['an array', '[]', 'array'],
        ['a string', '"x"', 'string'],
        ['a number', '5', 'number'],
        ['a boolean', 'true', 'bool'],
      ] as const) {
        it(`${name} instead of an object: 400`, async () => {
          await reject(body, `invalid request body: json: cannot unmarshal ${kind} into Go value of type api.${t.struct}`);
        });
      }

      for (const key of t.stringKeys) {
        for (const [what, literal, kind] of [
          ['a number', '5', 'number'],
          ['a boolean', 'true', 'bool'],
          ['an object', '{}', 'object'],
          ['an array', '[]', 'array'],
        ] as const) {
          it(`${what} for ${key}: 400`, async () => {
            await reject(
              bodyWith(t.valid, { [key]: literal }),
              `invalid request body: json: cannot unmarshal ${kind} into Go struct field ${t.struct}.${key} of type string`,
            );
          });
        }
      }

      if (hasUnits) {
        for (const [what, literal, kind] of [
          ['a string', '"5"', 'string'],
          ['a boolean', 'true', 'bool'],
          ['an object', '{}', 'object'],
          ['an array', '[]', 'array'],
          ['a fraction', '1.5', 'number 1.5'],
          ['a whole number written with a fraction', '2.0', 'number 2.0'],
          ['an exponent', '1e2', 'number 1e2'],
          ['a number beyond 64 bits', '9223372036854775808', 'number 9223372036854775808'],
        ] as const) {
          it(`${what} for units: 400`, async () => {
            await reject(
              bodyWith(t.valid, { units: literal }),
              `invalid request body: json: cannot unmarshal ${kind} into Go struct field ${t.struct}.units of type int`,
            );
          });
        }
      }
    });

    describe('required members', () => {
      const missing: Array<[string, string]> = [
        ['an empty object', '{}'],
        ['null', 'null'],
        ['unknown members only', '{"x":1}'],
        ['null members', bodyWith(t.valid, Object.fromEntries(Object.keys(t.valid).map((k) => [k, 'null'])))],
      ];
      for (const key of Object.keys(t.valid)) {
        missing.push([`no ${key}`, bodyWith(t.valid, { [key]: undefined })]);
        missing.push([`a null ${key}`, bodyWith(t.valid, { [key]: 'null' })]);
      }
      for (const key of t.stringKeys) missing.push([`an empty ${key}`, bodyWith(t.valid, { [key]: '""' })]);
      if (hasUnits) {
        missing.push(['zero units', bodyWith(t.valid, { units: '0' })]);
        missing.push(['negative units', bodyWith(t.valid, { units: '-1' })]);
        missing.push(['units of negative zero', bodyWith(t.valid, { units: '-0' })]);
        missing.push(['the smallest 64-bit units', bodyWith(t.valid, { units: '-9223372036854775808' })]);
      }
      for (const [name, body] of missing) {
        it(`${name}: 400`, async () => {
          await reject(body, t.required);
        });
      }
    });

    describe('what is accepted', () => {
      const accepted: Array<[name: string, body: string, headers?: Record<string, string>]> = [
        ['the plain body', valid],
        ['leading and trailing whitespace', `\n\t  ${valid}  \n`],
        ['text after the object', `${valid} and then some text`],
        ['a second object after the first (the first is used)', `${valid}{"units":-5}`],
        ['an unterminated value after the first', `${valid} [1,2`],
        ['unknown members, however nested', bodyWith(t.valid, { extra: '{"a":[1,{"b":null}],"c":"d"}', other: '1.5' })],
        ['member names in upper case', JSON.stringify(Object.fromEntries(Object.entries(t.valid).map(([k, x]) => [k.toUpperCase(), x])))],
        ['member names in lower case', JSON.stringify(Object.fromEntries(Object.entries(t.valid).map(([k, x]) => [k.toLowerCase(), x])))],
        ['member names with the first letter capitalised', JSON.stringify(Object.fromEntries(Object.entries(t.valid).map(([k, x]) => [k[0]!.toUpperCase() + k.slice(1), x])))],
        ['a repeated member: the last wins', `${valid.slice(0, -1)},${JSON.stringify(t.stringKeys[0])}:"last"}`],
        ['a repeated member: the last wins even when it is the valid one', bodyWith(t.valid, { [t.stringKeys[0]!]: '""' }).replace(/}$/, `,${JSON.stringify(t.stringKeys[0])}:"last"}`)],
        ['a unicode escape in a string', bodyWith(t.valid, { [t.stringKeys[0]!]: '"\\u0041\\u00e9\\ud83d\\ude00"' })],
        ['no Content-Type', valid],
        ['a form Content-Type', valid, { 'Content-Type': 'application/x-www-form-urlencoded' }],
        ['a text Content-Type', valid, { 'Content-Type': 'text/plain' }],
        ['an odd charset', valid, { 'Content-Type': 'application/json; charset=latin1' }],
      ];
      for (const [name, body, headers] of accepted) {
        it(name, async () => {
          await accept(body, headers);
        });
      }

      it('a 900 000 character string is read whole', async () => {
        gateway.clearScripts();
        const key = t.stringKeys[0]!;
        const sym = uid('VAL');
        const res = await post(t.open(sym), bodyWith(t.valid, { [key]: JSON.stringify('k'.repeat(900_000)) }));
        if (t.name.startsWith('POST /contracts')) {
          // Too long for the column: the insert fails and the route says so.
          assert.equal(res.status, 500);
        } else {
          assert.equal(res.status, 200);
          const sent = JSON.parse(gateway.requests[0]!.body) as Record<string, string>;
          assert.equal(sent[key]?.length, 900_000);
        }
      });
    });

    describe('size', () => {
      it('a body over 1 MiB is a 400 [go-text]', async () => {
        const key = t.stringKeys[0]!;
        await reject(bodyWith(t.valid, { [key]: JSON.stringify('k'.repeat((1 << 20) + 10)) }), 'invalid request body: http: request body too large');
      });

      it('garbage over 1 MiB is a 400 for its first bad byte, not for its size [go-text]', async () => {
        await reject('x'.repeat((1 << 20) + 10), "invalid request body: invalid character 'x' looking for beginning of value");
      });
    });
  });
}

describe('other things about bodies', () => {
  it('a chunked body is read like any other', async () => {
    gateway.on('POST', '/proxy/my/ships', { json: p.data(p.purchaseShipResult('S', 'T', TS_PURCHASE)) });
    const res = await post(`${API}/ships/purchase`, '{"shipType":"A","waypointSymbol":"B"}', { 'Transfer-Encoding': 'chunked' });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(JSON.parse(gateway.requests[0]!.body), { shipType: 'A', waypointSymbol: 'B' });
  });

  it('purchase-ship: whitespace-only values are values', async () => {
    gateway.on('POST', '/proxy/my/ships', { json: p.data(p.purchaseShipResult('S', 'T', TS_PURCHASE)) });
    const res = await post(`${API}/ships/purchase`, JSON.stringify({ shipType: ' ', waypointSymbol: '\t' }));
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(gateway.requests[0]!.body), { shipType: ' ', waypointSymbol: '\t' });
  });

  it('cargo: units up to the largest 64-bit integer are forwarded exactly', async () => {
    const sym = uid('VAL');
    gateway.on('POST', `/proxy/my/ships/${sym}/sell`, { json: p.data(p.marketResult(sym, 'X', 'SELL', TS_PURCHASE)) });
    const res = await post(`${API}/ships/${sym}/sell`, '{"symbol":"X","units":9223372036854775807}');
    assert.equal(res.status, 200);
    assert.match(gateway.requests[0]!.body, /"units"\s*:\s*9223372036854775807\b/);
  });

  it('cargo: the symbol is forwarded as sent, whatever JSON would escape in it', async () => {
    const sym = uid('VAL');
    gateway.on('POST', `/proxy/my/ships/${sym}/purchase`, { json: p.data(p.marketResult(sym, 'X', 'PURCHASE', TS_PURCHASE)) });
    const symbol = 'a"b\\c<d>&e é\u{1F600}';
    const res = await post(`${API}/ships/${sym}/purchase`, JSON.stringify({ symbol, units: 1 }));
    assert.equal(res.status, 200);
    assert.equal((JSON.parse(gateway.requests[0]!.body) as { symbol: string }).symbol, symbol);
  });

  it('purchase-ship: a body error comes before a missing member, which comes before the gateway', async () => {
    expectText(await post(`${API}/ships/purchase`, '{"shipType":'), 400, 'invalid request body: unexpected EOF');
    expectText(await post(`${API}/ships/purchase`, '{"shipType":"A"}'), 400, 'shipType and waypointSymbol are required');
    assert.deepEqual(gateway.requests, []);
  });

  it('path symbols are not validated: whatever the router accepts reaches the gateway', async () => {
    gateway.on('POST', '/proxy/my/ships/x%20y/sell', { json: p.data(p.marketResult('x y', 'X', 'SELL', TS_PURCHASE)) });
    const res = await post(`${API}/ships/x%20y/sell`, '{"symbol":"X","units":1}');
    assert.equal(res.status, 200);
  });
});
