// The routes that forward to st-gateway: what is sent, and how what comes back is
// turned into the answer.
//
// The service decodes the gateway's JSON into typed structures and encodes them
// again, so the answer is not the gateway's JSON. Zero values appear for missing
// members, unknown members disappear, absent lists become null, times are written
// back in a normalised form, and a body that does not fit the types is a 502. A
// port that forwards the JSON untouched breaks every one of those.
//
// Tests tagged [go-text] pin the standard library's wording of a decoding error,
// which the service puts in a 502 body. See "Behaviour notes" in the README.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { expectJson, expectText, expectTextStartingWith } from '../harness/expect.ts';
import type { GatewayReply } from '../harness/stubs.ts';
import { API, bearer, call, gateway, readerToken, uid, writerToken } from '../harness/world.ts';
import * as p from '../fixtures/payloads.ts';
import type { Json } from '../fixtures/payloads.ts';
import type { Route } from '../fixtures/routes.ts';
import { scriptUpstream, TS_PURCHASE, upstreamRoutes } from '../fixtures/routes.ts';

function authFor(route: Route): { Authorization: string } {
  return { Authorization: bearer(route.tier === 'write' ? writerToken() : readerToken()) };
}

function send(route: Route, extraHeaders: Record<string, string> = {}) {
  return call({
    method: route.method,
    path: route.path,
    headers: { ...authFor(route), ...extraHeaders },
    body: route.body === undefined ? undefined : JSON.stringify(route.body),
  });
}

describe('every upstream route, answered normally', () => {
  for (const template of upstreamRoutes('PROBE')) {
    it(`${template.id}: relays the gateway's answer and calls it as scripted`, async () => {
      const route = upstreamRoutes(uid('PX')).find((r) => r.id === template.id)!;
      scriptUpstream(gateway, route);
      const res = await send(route);
      expectJson(res, 200, route.expected as Json);
      assert.deepEqual(
        gateway.requests.map((r) => `${r.method} ${r.url}`),
        route.upstream.map((u) => `${u.method} ${u.target}`),
        'the gateway calls, in order',
      );
    });
  }

  it('GET routes send no body and no Content-Type to the gateway', async () => {
    for (const route of upstreamRoutes(uid('PX')).filter((r) => r.method === 'GET')) {
      gateway.clearScripts();
      scriptUpstream(gateway, route);
      await send(route);
      for (const seen of gateway.requests) {
        assert.equal(seen.body, '', route.id);
        assert.equal(seen.headers['content-type'], undefined, route.id);
      }
    }
  });

  it('accept and fulfill send no body and no Content-Type to the gateway', async () => {
    for (const route of upstreamRoutes(uid('PX')).filter((r) => /\/(accept|fulfill)$/.test(r.id))) {
      gateway.clearScripts();
      scriptUpstream(gateway, route);
      await send(route);
      assert.equal(gateway.requests[0]?.body, '', route.id);
      assert.equal(gateway.requests[0]?.headers['content-type'], undefined, route.id);
    }
  });

  it('accept and fulfill ignore whatever body they are sent', async () => {
    for (const route of upstreamRoutes(uid('PX')).filter((r) => /\/(accept|fulfill)$/.test(r.id))) {
      gateway.clearScripts();
      scriptUpstream(gateway, route);
      const res = await call({ method: 'POST', path: route.path, headers: authFor(route), body: 'not json at all' });
      assert.equal(res.status, 200, route.id);
      assert.equal(gateway.requests[0]?.body, '', route.id);
    }
  });

  it('POST /ships/purchase sends exactly {shipType, waypointSymbol} as JSON', async () => {
    const route = upstreamRoutes(uid('PX')).find((r) => r.id === 'POST /ships/purchase')!;
    scriptUpstream(gateway, route);
    const res = await call({
      method: 'POST',
      path: route.path,
      headers: authFor(route),
      body: JSON.stringify({ shipType: 'SHIP_PROBE', waypointSymbol: 'X1-W', extra: 'dropped', nested: { a: 1 } }),
    });
    assert.equal(res.status, 200);
    const seen = gateway.requests[0]!;
    assert.equal(seen.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(seen.body), { shipType: 'SHIP_PROBE', waypointSymbol: 'X1-W' });
  });

  for (const action of ['purchase', 'sell']) {
    it(`POST /ships/{shipSymbol}/${action} sends exactly {symbol, units} as JSON, the units a number`, async () => {
      const route = upstreamRoutes(uid('PX')).find((r) => r.id === `POST /ships/{shipSymbol}/${action}`)!;
      scriptUpstream(gateway, route);
      const res = await call({
        method: 'POST',
        path: route.path,
        headers: authFor(route),
        body: JSON.stringify({ symbol: 'FUEL', units: 12, extra: true }),
      });
      assert.equal(res.status, 200);
      const seen = gateway.requests[0]!;
      assert.equal(seen.headers['content-type'], 'application/json');
      assert.deepEqual(JSON.parse(seen.body), { symbol: 'FUEL', units: 12 });
    });
  }

  it('GET /current-agent calls agent, ships, contracts, one after the other, and stops at the first failure', async () => {
    const route = upstreamRoutes(uid('PX')).find((r) => r.id === 'GET /current-agent')!;
    gateway.on('GET', '/proxy/my/agent', { json: p.data(p.agent()) });
    gateway.on('GET', '/proxy/my/ships', { status: 500, json: { error: { message: 'boom' } } });
    const res = await send(route);
    expectText(res, 500, 'boom');
    assert.deepEqual(
      gateway.requests.map((r) => `${r.method} ${r.url}`),
      ['GET /proxy/my/agent', 'GET /proxy/my/ships'],
    );
  });

  it('GET /current-agent fails on the first call without making the others', async () => {
    const route = upstreamRoutes(uid('PX')).find((r) => r.id === 'GET /current-agent')!;
    gateway.on('GET', '/proxy/my/agent', { status: 418, json: { error: { message: 'teapot' } } });
    expectText(await send(route), 418, 'teapot');
    assert.equal(gateway.requests.length, 1);
  });

  it('GET /current-agent fails on the last call after making all three', async () => {
    const route = upstreamRoutes(uid('PX')).find((r) => r.id === 'GET /current-agent')!;
    gateway.on('GET', '/proxy/my/agent', { json: p.data(p.agent()) });
    gateway.on('GET', '/proxy/my/ships', { json: p.listOf([]) });
    gateway.on('GET', '/proxy/my/contracts', { status: 409, json: { error: { message: 'cooldown' } } });
    expectText(await send(route), 409, 'cooldown');
    assert.equal(gateway.requests.length, 3);
  });
});

// ---------------------------------------------------------------------------
// The round trip through typed structures.

interface Kind {
  name: string;
  path: string;
  target: string;
  zero: Json;
  full: Record<string, Json>;
  /** The Go type the body is decoded into, for the [go-text] messages. */
  wrapper: string;
}

const KINDS: Kind[] = [
  { name: 'agent', path: `${API}/agent`, target: '/proxy/my/agent', zero: p.zeroAgent, full: p.agent(), wrapper: 'GetMyAgentResponse' },
  { name: 'ship', path: `${API}/ships/S1`, target: '/proxy/my/ships/S1', zero: p.zeroShip, full: p.ship('S1'), wrapper: 'GetMyShipResponse' },
  {
    name: 'contract',
    path: `${API}/contracts/C1`,
    target: '/proxy/my/contracts/C1',
    zero: p.zeroContract,
    full: p.contract('C1'),
    wrapper: 'GetMyContractResponse',
  },
];

async function fetchKind(kind: Kind, reply: GatewayReply) {
  gateway.on('GET', kind.target, reply);
  return call({ path: kind.path, headers: authed() });
}

function authed(): { Authorization: string } {
  return { Authorization: bearer(readerToken()) };
}

describe('a single object is decoded and encoded again', () => {
  for (const kind of KINDS) {
    describe(kind.name, () => {
      it('a full answer comes back as it went in', async () => {
        expectJson(await fetchKind(kind, { json: p.data(kind.full) }), 200, kind.full);
      });

      it('missing members become zero values: "" 0 false, the zero time, null lists', async () => {
        expectJson(await fetchKind(kind, { json: { data: {} } }), 200, kind.zero);
      });

      it('a missing data member is the same as an empty one', async () => {
        expectJson(await fetchKind(kind, { json: {} }), 200, kind.zero);
        gateway.clearScripts();
        expectJson(await fetchKind(kind, { json: { data: null } }), 200, kind.zero);
      });

      it('an empty 200 body is a zero value, not an error', async () => {
        expectJson(await fetchKind(kind, { raw: '' }), 200, kind.zero);
      });

      it('a JSON null body is a zero value, not an error', async () => {
        expectJson(await fetchKind(kind, { raw: 'null' }), 200, kind.zero);
      });

      it('a 204 is a zero value, not an error', async () => {
        expectJson(await fetchKind(kind, { status: 204, raw: '' }), 200, kind.zero);
      });

      it('a 3xx without a Location is a zero value, not an error', async () => {
        expectJson(await fetchKind(kind, { status: 304, raw: '' }), 200, kind.zero);
      });

      it('members it does not know are dropped, at any depth', async () => {
        const extended = structuredClone(kind.full) as Record<string, Json>;
        extended['unknownTop'] = 'x';
        extended['unknownObject'] = { a: [1, 2, { b: null }] };
        for (const value of Object.values(extended)) {
          if (value !== null && typeof value === 'object' && !Array.isArray(value)) value['unknownNested'] = 42;
        }
        expectJson(await fetchKind(kind, { json: p.data(extended) }), 200, kind.full);
      });

      it('the Content-Type the gateway sends does not matter', async () => {
        const res = await fetchKind(kind, { raw: JSON.stringify(p.data(kind.full)), headers: { 'Content-Type': 'text/plain' } });
        expectJson(res, 200, kind.full);
      });

      it('null members are zero values', async () => {
        const nulls: Record<string, Json> = {};
        for (const key of Object.keys(kind.full)) nulls[key] = null;
        expectJson(await fetchKind(kind, { json: p.data(nulls) }), 200, kind.zero);
      });

      it('a repeated key: the last one wins', async () => {
        const first = JSON.stringify(kind.full).slice(1, -1);
        const res = await fetchKind(kind, { raw: `{"data":{"id":"first","symbol":"first",${first},"id":"last","symbol":"last"}}` });
        assert.equal(res.status, 200);
        const body = JSON.parse(res.text) as Record<string, Json>;
        for (const key of ['id', 'symbol']) if (key in body) assert.equal(body[key], 'last');
      });

      it('a body that is not an object of the right type is a 502 [go-text]', async () => {
        for (const [raw, message] of [
          ['not json', "invalid character 'o' in literal null (expecting 'u')"],
          ['{"data":', 'unexpected end of JSON input'],
          ['   ', 'unexpected end of JSON input'],
          ['[]', `json: cannot unmarshal array into Go value of type schema.${kind.wrapper}`],
          ['"text"', `json: cannot unmarshal string into Go value of type schema.${kind.wrapper}`],
          ['7', `json: cannot unmarshal number into Go value of type schema.${kind.wrapper}`],
          ['true', `json: cannot unmarshal bool into Go value of type schema.${kind.wrapper}`],
          ['{"data":[]}', `json: cannot unmarshal array into Go struct field ${kind.wrapper}.data of type schema.${kind.name === 'agent' ? 'Agent' : kind.name === 'ship' ? 'Ship' : 'Contract'}`],
          ['{"data":"x"}', `json: cannot unmarshal string into Go struct field ${kind.wrapper}.data of type schema.${kind.name === 'agent' ? 'Agent' : kind.name === 'ship' ? 'Ship' : 'Contract'}`],
          ['{"data":{}} trailing', "invalid character 't' after top-level value"],
          ['{"data":{}}{}', "invalid character '{' after top-level value"],
        ] as Array<[string, string]>) {
          gateway.clearScripts();
          expectText(await fetchKind(kind, { raw }), 502, message);
        }
      });
    });
  }
});

describe('agent: number handling', () => {
  const agentPath = `${API}/agent`;
  const reply = (members: string): GatewayReply => ({ raw: `{"data":{${members}}}` });

  async function agent(members: string) {
    gateway.clearScripts();
    gateway.on('GET', '/proxy/my/agent', reply(members));
    return call({ path: agentPath, headers: authed() });
  }

  it('an integer beyond 2^53 survives exactly', async () => {
    const res = await agent('"credits":9007199254740993,"shipCount":2147483647');
    assert.equal(res.status, 200);
    assert.match(res.text, /"credits"\s*:\s*9007199254740993\b/);
    assert.match(res.text, /"shipCount"\s*:\s*2147483647\b/);
  });

  it('the largest and smallest int64 survive exactly', async () => {
    const hi = await agent('"credits":9223372036854775807');
    assert.match(hi.text, /"credits"\s*:\s*9223372036854775807\b/);
    const lo = await agent('"credits":-9223372036854775808');
    assert.match(lo.text, /"credits"\s*:\s*-9223372036854775808\b/);
  });

  it('negative values pass through', async () => {
    expectJson(await agent('"credits":-5,"shipCount":-1'), 200, { ...p.zeroAgent, credits: -5, shipCount: -1 });
  });

  it('a number with an exponent or a fraction is not an integer: 502 [go-text]', async () => {
    for (const [literal, text] of [
      ['1e3', '1e3'],
      ['5.0', '5.0'],
      ['1.5', '1.5'],
      ['9223372036854775808', '9223372036854775808'],
      ['-9223372036854775809', '-9223372036854775809'],
    ]) {
      expectText(await agent(`"credits":${literal}`), 502, `json: cannot unmarshal number ${text} into Go struct field Agent.data.credits of type int64`);
    }
  });

  it('shipCount is a 64-bit int too, not a 32-bit one', async () => {
    const res = await agent('"shipCount":4294967296');
    assert.match(res.text, /"shipCount"\s*:\s*4294967296\b/);
  });

  it('a string where a number belongs is a 502 [go-text]', async () => {
    expectText(await agent('"credits":"5"'), 502, 'json: cannot unmarshal string into Go struct field Agent.data.credits of type int64');
    expectText(await agent('"shipCount":"5"'), 502, 'json: cannot unmarshal string into Go struct field Agent.data.shipCount of type int');
  });

  it('a number where a string belongs is a 502 [go-text]', async () => {
    expectText(await agent('"symbol":5'), 502, 'json: cannot unmarshal number into Go struct field Agent.data.symbol of type string');
    expectText(await agent('"symbol":true'), 502, 'json: cannot unmarshal bool into Go struct field Agent.data.symbol of type string');
    expectText(await agent('"symbol":{}'), 502, 'json: cannot unmarshal object into Go struct field Agent.data.symbol of type string');
  });
});

describe('agent: string handling', () => {
  async function agentWith(rawBody: string | Buffer) {
    gateway.on('GET', '/proxy/my/agent', { raw: rawBody });
    return call({ path: `${API}/agent`, headers: authed() });
  }

  it('member names match case-insensitively', async () => {
    const res = await agentWith('{"DATA":{"SYMBOL":"AbC","Credits":5,"startingfaction":"F","accountid":"A","HEADQUARTERS":"H","SHIPCOUNT":3}}');
    expectJson(res, 200, { accountId: 'A', symbol: 'AbC', headquarters: 'H', credits: 5, startingFaction: 'F', shipCount: 3 });
  });

  it('but not with other punctuation', async () => {
    expectJson(await agentWith('{"data":{"starting_faction":"F","account-id":"A"}}'), 200, p.zeroAgent);
  });

  it('invalid UTF-8 becomes U+FFFD', async () => {
    const res = await agentWith(Buffer.concat([Buffer.from('{"data":{"symbol":"a'), Buffer.from([0xff, 0xfe]), Buffer.from('b"}}')]));
    expectJson(res, 200, { ...p.zeroAgent, symbol: 'a��b' });
  });

  it('a lone surrogate escape becomes U+FFFD, a pair becomes one character', async () => {
    const res = await agentWith('{"data":{"symbol":"x\\ud83dy","headquarters":"\\ud83d\\ude00 \\u00e9"}}');
    expectJson(res, 200, { ...p.zeroAgent, symbol: 'x�y', headquarters: '\u{1F600} é' });
  });

  it('characters that encoding/json escapes on output (< > & U+2028) are the same strings after parsing', async () => {
    const res = await agentWith('{"data":{"symbol":"<a>&\\u2028\\u2029</a>","headquarters":"\\u003cb\\u003e"}}');
    expectJson(res, 200, { ...p.zeroAgent, symbol: '<a>&  </a>', headquarters: '<b>' });
  });

  it('control characters and quotes survive', async () => {
    const res = await agentWith('{"data":{"symbol":"a\\"b\\\\c\\n\\t\\u0000\\u001f"}}');
    expectJson(res, 200, { ...p.zeroAgent, symbol: 'a"b\\c\n\t\u0000\u001f' });
  });

  it('a very long string is not truncated', async () => {
    const long = 'x'.repeat(200_000);
    const res = await agentWith(JSON.stringify({ data: { symbol: long } }));
    expectJson(res, 200, { ...p.zeroAgent, symbol: long });
  });
});

describe('times are parsed and written back as RFC 3339', () => {
  // Go reads RFC 3339 (the T and Z in upper case, an offset or Z required) and
  // writes it back with the offset it read, a Z for UTC, and the shortest
  // fraction that is exact: zero seconds-fractions disappear.
  const normalised: Array<[sent: string, back: string]> = [
    ['2026-01-02T03:04:05Z', '2026-01-02T03:04:05Z'],
    ['2026-01-02T03:04:05.000Z', '2026-01-02T03:04:05Z'],
    ['2026-01-02T03:04:05.100Z', '2026-01-02T03:04:05.1Z'],
    ['2026-01-02T03:04:05.120Z', '2026-01-02T03:04:05.12Z'],
    ['2026-01-02T03:04:05.123Z', '2026-01-02T03:04:05.123Z'],
    ['2026-01-02T03:04:05.123456Z', '2026-01-02T03:04:05.123456Z'],
    ['2026-01-02T03:04:05.123456789Z', '2026-01-02T03:04:05.123456789Z'],
    ['2026-01-02T03:04:05.9999999999Z', '2026-01-02T03:04:05.999999999Z'],
    ['2026-01-02T03:04:05+00:00', '2026-01-02T03:04:05Z'],
    ['2026-01-02T03:04:05+02:00', '2026-01-02T03:04:05+02:00'],
    ['2026-01-02T03:04:05-05:30', '2026-01-02T03:04:05-05:30'],
    ['2026-01-02T03:04:05.500+02:00', '2026-01-02T03:04:05.5+02:00'],
    ['0001-01-01T00:00:00Z', '0001-01-01T00:00:00Z'],
    ['9999-12-31T23:59:59Z', '9999-12-31T23:59:59Z'],
  ];

  for (const [sent, back] of normalised) {
    it(`${sent} -> ${back}`, async () => {
      const contract = { ...p.contract('C1'), expiration: sent } as Record<string, Json>;
      gateway.on('GET', '/proxy/my/contracts/C1', { json: p.data(contract) });
      const res = await call({ path: `${API}/contracts/C1`, headers: authed() });
      expectJson(res, 200, { ...p.contract('C1'), expiration: back });
    });
  }

  const rejected = [
    '2026-01-02 03:04:05Z',
    '2026-01-02t03:04:05z',
    '2026-01-02T03:04:05',
    '2026-01-02',
    '03:04:05Z',
    'not a time',
    '',
    '2026-12-31T23:59:60Z',
    '2026-13-02T03:04:05Z',
    '2026-02-30T03:04:05Z',
    '2026-01-02T24:04:05Z',
    '2026-01-02T03:04:05+0200',
    ' 2026-01-02T03:04:05Z',
  ];
  for (const sent of rejected) {
    it(`${JSON.stringify(sent)} cannot be read: 502 with a text/plain explanation`, async () => {
      gateway.on('GET', '/proxy/my/contracts/C1', { json: p.data({ ...p.contract('C1'), expiration: sent }) });
      const res = await call({ path: `${API}/contracts/C1`, headers: authed() });
      assert.equal(res.status, 502);
      assert.equal(res.headers['content-type'], 'text/plain; charset=utf-8');
      assert.ok(res.text.length > 1);
    });
  }

  it('a number where a time belongs is a 502 [go-text]', async () => {
    gateway.on('GET', '/proxy/my/contracts/C1', { json: p.data({ ...p.contract('C1'), expiration: 1700000000 }) });
    const res = await call({ path: `${API}/contracts/C1`, headers: authed() });
    expectText(res, 502, 'Time.UnmarshalJSON: input is not a JSON string');
  });

  it('a null time is the zero time', async () => {
    gateway.on('GET', '/proxy/my/contracts/C1', { json: p.data({ ...p.contract('C1'), expiration: null }) });
    const res = await call({ path: `${API}/contracts/C1`, headers: authed() });
    expectJson(res, 200, { ...p.contract('C1'), expiration: p.ZERO_TIME });
  });

  it('every time in the tree is treated alike (ships)', async () => {
    const ship = p.withPath(p.ship('S1'), ['nav', 'route', 'arrival'], '2026-01-02T03:04:05.500Z');
    gateway.on('GET', '/proxy/my/ships/S1', { json: p.data(p.withPath(ship, ['fuel', 'consumed', 'timestamp'], '2026-01-02T05:04:05+02:00')) });
    const res = await call({ path: `${API}/ships/S1`, headers: authed() });
    expectJson(
      res,
      200,
      p.withPath(p.withPath(p.ship('S1'), ['nav', 'route', 'arrival'], '2026-01-02T03:04:05.5Z'), ['fuel', 'consumed', 'timestamp'], '2026-01-02T05:04:05+02:00'),
    );
  });
});

describe('lists', () => {
  const lists = [
    { name: 'ships', path: `${API}/ships`, target: '/proxy/my/ships', item: p.ship('L1'), zero: p.zeroShip, wrapper: 'GetMyShipsResponse', element: 'Ship' },
    {
      name: 'contracts',
      path: `${API}/contracts`,
      target: '/proxy/my/contracts',
      item: p.contract('L1'),
      zero: p.zeroContract,
      wrapper: 'GetMyContractsResponse',
      element: 'Contract',
    },
  ];

  for (const list of lists) {
    describe(list.name, () => {
      async function get(reply: GatewayReply) {
        gateway.clearScripts();
        gateway.on('GET', list.target, reply);
        return call({ path: list.path, headers: authed() });
      }

      it('keeps the order and drops the meta', async () => {
        const items = ['a', 'b', 'c'].map((id) => (list.name === 'ships' ? p.ship(id) : p.contract(id)));
        const res = await get({ json: { data: items, meta: { total: 3, page: 1, limit: 20 } } });
        expectJson(res, 200, items);
      });

      it('an empty list is [], not null', async () => {
        expectJson(await get({ json: { data: [], meta: { total: 0, page: 1, limit: 20 } } }), 200, []);
      });

      it('a missing or null data member is null, not []', async () => {
        expectJson(await get({ json: { meta: { total: 0 } } }), 200, null);
        expectJson(await get({ json: { data: null } }), 200, null);
        expectJson(await get({ json: {} }), 200, null);
        expectJson(await get({ raw: '' }), 200, null);
        expectJson(await get({ raw: 'null' }), 200, null);
        expectJson(await get({ status: 204, raw: '' }), 200, null);
      });

      it('a null element is a zero element', async () => {
        expectJson(await get({ json: { data: [null, {}] } }), 200, [list.zero, list.zero]);
      });

      it('a data member that is not a list is a 502 [go-text]', async () => {
        expectText(await get({ raw: '{"data":{}}' }), 502, `json: cannot unmarshal object into Go struct field ${list.wrapper}.data of type []schema.${list.element}`);
        expectText(await get({ raw: '{"data":[1]}' }), 502, `json: cannot unmarshal number into Go struct field ${list.wrapper}.data of type schema.${list.element}`);
      });

      it('a malformed meta is a 502 even though it is dropped [go-text]', async () => {
        expectText(
          await get({ raw: '{"data":[],"meta":{"total":"x"}}' }),
          502,
          `json: cannot unmarshal string into Go struct field PaginationMeta.meta.total of type int`,
        );
      });

      it('a meta of the wrong shape is a 502 [go-text]', async () => {
        expectTextStartingWith(await get({ raw: '{"data":[],"meta":[]}' }), 502, 'json: cannot unmarshal array into Go struct field');
      });
    });
  }
});

describe('/current-agent', () => {
  const sym = 'CA1';
  const route = () => upstreamRoutes(sym).find((r) => r.id === 'GET /current-agent')!;

  it('bundles agent, ships and contracts', async () => {
    scriptUpstream(gateway, route());
    expectJson(await send(route()), 200, { agent: p.agent(), ships: [p.ship(sym)], contracts: [p.contract(sym)] });
  });

  it('empty and missing lists are [] and null, member by member', async () => {
    gateway.on('GET', '/proxy/my/agent', { json: { data: {} } });
    gateway.on('GET', '/proxy/my/ships', { json: { data: [] } });
    gateway.on('GET', '/proxy/my/contracts', { json: {} });
    expectJson(await send(route()), 200, { agent: p.zeroAgent, ships: [], contracts: null });
  });

  it('an undecodable third answer discards the first two: 502 [go-text]', async () => {
    gateway.on('GET', '/proxy/my/agent', { json: p.data(p.agent()) });
    gateway.on('GET', '/proxy/my/ships', { json: p.listOf([]) });
    gateway.on('GET', '/proxy/my/contracts', { raw: '<html>' });
    expectText(await send(route()), 502, "invalid character '<' looking for beginning of value");
  });
});

describe('write routes, answered normally', () => {
  it('purchase-ship relays the gateway\'s answer with the timestamps normalised', async () => {
    const sym = uid('PS');
    gateway.on('POST', '/proxy/my/ships', {
      json: p.data(p.purchaseShipResult(sym, 'SHIP_MINING_DRONE', '2026-03-04T05:06:07.000Z')),
    });
    const res = await call({
      method: 'POST',
      path: `${API}/ships/purchase`,
      headers: { Authorization: bearer(writerToken()) },
      body: JSON.stringify({ shipType: 'SHIP_MINING_DRONE', waypointSymbol: 'X1-AB12-C3' }),
    });
    expectJson(res, 200, p.purchaseShipResult(sym, 'SHIP_MINING_DRONE', TS_PURCHASE));
  });

  it('purchase-ship with an empty answer is a zero result', async () => {
    gateway.on('POST', '/proxy/my/ships', { raw: '' });
    const res = await call({
      method: 'POST',
      path: `${API}/ships/purchase`,
      headers: { Authorization: bearer(writerToken()) },
      body: JSON.stringify({ shipType: 'SHIP_MINING_DRONE', waypointSymbol: 'X1-AB12-C3' }),
    });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.text) as Record<string, Record<string, Json>>;
    assert.deepEqual(body['agent'], p.zeroAgent);
    assert.deepEqual(body['ship'], p.zeroShip);
    assert.deepEqual(body['transaction'], { waypointSymbol: '', shipType: '', price: 0, agentSymbol: '', timestamp: p.ZERO_TIME });
  });

  it('market transactions: an empty answer is a zero result with a null inventory', async () => {
    const sym = uid('MK');
    gateway.on('POST', `/proxy/my/ships/${sym}/sell`, { raw: '' });
    const res = await call({
      method: 'POST',
      path: `${API}/ships/${sym}/sell`,
      headers: { Authorization: bearer(writerToken()) },
      body: JSON.stringify({ symbol: 'IRON_ORE', units: 1 }),
    });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.text) as Record<string, Json>;
    assert.deepEqual(body['agent'], p.zeroAgent);
    assert.deepEqual(body['cargo'], { capacity: 0, units: 0, inventory: null });
    assert.deepEqual(body['transaction'], {
      waypointSymbol: '',
      shipSymbol: '',
      tradeSymbol: '',
      type: '',
      units: 0,
      pricePerUnit: 0,
      totalPrice: 0,
      timestamp: p.ZERO_TIME,
    });
  });

  it('contract state changes: an empty answer is a zero agent and a zero contract', async () => {
    const sym = uid('CT');
    gateway.on('POST', `/proxy/my/contracts/${sym}/accept`, { raw: '' });
    const res = await call({ method: 'POST', path: `${API}/contracts/${sym}/accept`, headers: { Authorization: bearer(writerToken()) } });
    expectJson(res, 200, { agent: p.zeroAgent, contract: p.zeroContract });
  });
});

describe('the gateway redirects', () => {
  // The HTTP client follows redirects (at most ten), carrying the caller's
  // Authorization header along to the same host. A port built on a different
  // client has to do the same, or stop where Go stops.
  it('a GET redirect is followed, with the Authorization header', async () => {
    gateway.on('GET', '/proxy/my/agent', { status: 302, headers: { Location: '/proxy/moved/agent' } });
    gateway.on('GET', '/proxy/moved/agent', { json: p.data(p.agent()) });
    const token = readerToken();
    const res = await call({ path: `${API}/agent`, headers: { Authorization: bearer(token) } });
    expectJson(res, 200, p.agent());
    assert.equal(gateway.requests.length, 2);
    assert.equal(gateway.requests[1]?.headers['authorization'], bearer(token));
  });

  it('a 307 redirect of a POST is followed with its body', async () => {
    const sym = uid('RD');
    gateway.on('POST', `/proxy/my/ships/${sym}/sell`, { status: 307, headers: { Location: `/proxy/moved/${sym}` } });
    gateway.on('POST', `/proxy/moved/${sym}`, { json: p.data(p.marketResult(sym, 'IRON_ORE', 'SELL', TS_PURCHASE)) });
    const res = await call({
      method: 'POST',
      path: `${API}/ships/${sym}/sell`,
      headers: { Authorization: bearer(writerToken()) },
      body: JSON.stringify({ symbol: 'IRON_ORE', units: 2 }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(gateway.requests[1]!.body), { symbol: 'IRON_ORE', units: 2 });
  });

  it('a redirect loop ends after ten requests as "st-gateway did not answer"', async () => {
    gateway.on('GET', '/proxy/my/agent', { status: 302, headers: { Location: '/proxy/my/agent' } });
    const res = await call({ path: `${API}/agent`, headers: authed() });
    expectText(res, 504, 'st-gateway did not answer');
    assert.equal(gateway.requests.length, 10);
  });
});
