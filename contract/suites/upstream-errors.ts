// What a caller receives when st-gateway does not answer with a 2xx.
//
// The shared contract is meta/fixtures/gateway-errors.json (vendored in
// fixtures/, pinned by sha256). Every case of it is replayed against every route
// that calls the gateway, not only GET /agent. The rest of the file pins the
// parts the fixture leaves open: which headers are relayed, how a message is
// lifted out of an error body, how a status is mapped, and what a dead
// connection looks like.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CORS_HEADERS, expectText, relevantHeaders, TEXT_TYPE } from '../harness/expect.ts';
import type { GatewayReply } from '../harness/stubs.ts';
import { bearer, call, gateway, readerToken, uid, writerToken } from '../harness/world.ts';
import * as p from '../fixtures/payloads.ts';
import type { Route } from '../fixtures/routes.ts';
import { upstreamRoutes } from '../fixtures/routes.ts';

interface FixtureCase {
  name: string;
  why: string;
  gateway: {
    transport?: string;
    status?: number;
    body?: string;
    headers?: Record<string, string>;
    bodyRepeat?: { chunk: string; times: number };
  };
  expect: Record<string, unknown>;
}

// An expectation key this suite cannot check fails the case instead of being
// skipped: a fixture that grows a key must not quietly degrade to a status-only
// test that goes on reporting green.
const KNOWN_EXPECTATIONS = new Set(['status', 'message', 'messageContains', 'messageNotEmpty', 'messageMaxLength', 'headers']);

function loadCases(): FixtureCase[] {
  const file = JSON.parse(readFileSync(new URL('../fixtures/gateway-errors.json', import.meta.url), 'utf8')) as {
    cases?: FixtureCase[];
  };
  const cases = file.cases ?? [];
  assert.ok(cases.length >= 10, `expected the full contract, got ${cases.length} cases`);
  return cases;
}

function tokenFor(route: Route): string {
  return route.tier === 'write' ? writerToken() : readerToken();
}

async function drive(route: Route, reply: GatewayReply | 'refuse') {
  const first = route.upstream[0]!;
  if (reply === 'refuse') {
    await gateway.refuse();
  } else {
    gateway.on(first.method, first.target, reply);
  }
  try {
    return await call({
      method: route.method,
      path: route.path,
      headers: { Authorization: bearer(tokenFor(route)) },
      body: route.body === undefined ? undefined : JSON.stringify(route.body),
    });
  } finally {
    if (reply === 'refuse') await gateway.restore();
  }
}

function asReply(c: FixtureCase): GatewayReply | 'refuse' {
  if (c.gateway.transport === 'no-response') return 'refuse';
  assert.equal(c.gateway.transport, undefined, `unknown transport ${c.gateway.transport}`);
  const body = c.gateway.bodyRepeat !== undefined ? c.gateway.bodyRepeat.chunk.repeat(c.gateway.bodyRepeat.times) : (c.gateway.body ?? '');
  return { status: c.gateway.status, raw: body, headers: c.gateway.headers };
}

function check(c: FixtureCase, res: { status: number; text: string; headers: Record<string, string | string[] | undefined> }): void {
  for (const key of Object.keys(c.expect)) assert.ok(KNOWN_EXPECTATIONS.has(key), `the fixture asserts ${JSON.stringify(key)}, which this suite cannot check`);
  assert.equal(res.status, c.expect['status'], `status (body: ${res.text.slice(0, 200)})`);
  // The relayed sentence is the body without the newline http.Error appends.
  const message = res.text.replace(/\n+$/, '');
  if ('message' in c.expect) assert.equal(message, c.expect['message']);
  if ('messageContains' in c.expect) assert.ok(message.includes(c.expect['messageContains'] as string), `message ${JSON.stringify(message)}`);
  if (c.expect['messageNotEmpty'] === true) assert.ok(message.trim() !== '', 'the message must not be empty');
  if ('messageMaxLength' in c.expect) assert.ok([...message].length <= (c.expect['messageMaxLength'] as number), `message is ${[...message].length} characters`);
  for (const [name, value] of Object.entries((c.expect['headers'] ?? {}) as Record<string, string>)) {
    assert.equal(res.headers[name.toLowerCase()], value, `header ${name}`);
  }
  assert.equal(res.headers['content-type'], TEXT_TYPE);
  for (const [name, value] of Object.entries(CORS_HEADERS)) assert.equal(res.headers[name], value, name);
}

describe('gateway-errors.json, on every route that calls the gateway', () => {
  for (const c of loadCases()) {
    describe(c.name, () => {
      for (const template of upstreamRoutes('PROBE')) {
        it(template.id, async () => {
          const route = upstreamRoutes(uid('UE')).find((r) => r.id === template.id)!;
          const res = await drive(route, asReply(c));
          check(c, res);
        });
      }
    });
  }
});

describe('pacing headers', () => {
  const all = {
    'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT',
    'X-RateLimit-Limit': '2',
    'X-RateLimit-Remaining': '0',
    'X-RateLimit-Reset': '2026-01-01T00:00:00.000Z',
  };
  const relayed = {
    'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT',
    'x-ratelimit-limit': '2',
    'x-ratelimit-remaining': '0',
    'x-ratelimit-reset': '2026-01-01T00:00:00.000Z',
  };
  const read = (route: Route) => drive(route, { status: 429, json: { error: { message: 'slow' } }, headers: all });

  it('all four are relayed, verbatim, on a 429', async () => {
    const route = upstreamRoutes(uid('PH'))[0]!;
    expectText(await read(route), 429, 'slow', { headers: relayed });
  });

  it('are relayed on any error status, not only 429', async () => {
    for (const status of [400, 404, 409, 500, 502, 503]) {
      gateway.clearScripts();
      const route = upstreamRoutes(uid('PH'))[0]!;
      expectText(await drive(route, { status, json: { error: { message: `s${status}` } }, headers: all }), status, `s${status}`, { headers: relayed });
    }
  });

  it('are relayed by every route', async () => {
    for (const route of upstreamRoutes(uid('PH'))) {
      gateway.clearScripts();
      expectText(await read(route), 429, 'slow', { headers: relayed });
    }
  });

  it('only those that are present, and only the non-empty ones', async () => {
    const route = upstreamRoutes(uid('PH'))[0]!;
    const res = await drive(route, {
      status: 429,
      json: { error: { message: 'slow' } },
      headers: { 'Retry-After': '9', 'X-RateLimit-Limit': '' },
    });
    expectText(res, 429, 'slow', { headers: { 'retry-after': '9' } });
  });

  it('no other header of the gateway\'s answer is relayed', async () => {
    const route = upstreamRoutes(uid('PH'))[0]!;
    const res = await drive(route, {
      status: 500,
      json: { error: { message: 'x' } },
      headers: {
        'Set-Cookie': 'a=b',
        'Cache-Control': 'no-store',
        Location: '/elsewhere',
        'X-Request-Id': 'abc',
        'Content-Language': 'de',
        'WWW-Authenticate': 'Bearer',
        'Access-Control-Allow-Origin': 'https://evil.example.test',
        'X-RateLimit-Policy': 'x',
      },
    });
    expectText(res, 500, 'x');
    assert.equal(res.headers['x-request-id'], undefined);
  });

  it('are not relayed on a success', async () => {
    const route = upstreamRoutes(uid('PH'))[0]!;
    const res = await drive(route, { json: p.data(p.agent()), headers: all });
    assert.equal(res.status, 200);
    assert.deepEqual(
      Object.keys(relevantHeaders(res)).filter((n) => n === 'retry-after' || n.startsWith('x-ratelimit-')),
      [],
    );
  });
});

describe('lifting the message out of an error body', () => {
  async function relayedBody(raw: string, status = 500) {
    gateway.clearScripts();
    const route = upstreamRoutes(uid('MSG'))[0]!;
    const res = await drive(route, { status, raw });
    assert.equal(res.status, status);
    assert.equal(res.headers['content-type'], TEXT_TYPE);
    return res.text;
  }

  const cases: Array<[name: string, body: string, text: string]> = [
    ['an envelope with a code and other members', '{"error":{"message":"m","code":4214},"other":2}', 'm\n'],
    ['a message with surrounding blanks is not trimmed', '{"error":{"message":"  m  "}}', '  m  \n'],
    ['a message with a newline', '{"error":{"message":"a\\nb"}}', 'a\nb\n'],
    ['unicode escapes are decoded', '{"error":{"message":"caf\\u00e9 \\u003cb\\u003e & more"}}', 'café <b> & more\n'],
    ['a blank message falls back to the raw body', '{"error":{"message":"   "}}', '{"error":{"message":"   "}}\n'],
    ['an empty message falls back to the raw body', '{"error":{"message":""}}', '{"error":{"message":""}}\n'],
    ['no message falls back to the raw body', '{"error":{"code":1}}', '{"error":{"code":1}}\n'],
    ['an error that is a string falls back to the raw body', '{"error":"text"}', '{"error":"text"}\n'],
    ['a message that is a number falls back to the raw body', '{"error":{"message":5}}', '{"error":{"message":5}}\n'],
    ['a null error falls back to the raw body', '{"error":null}', '{"error":null}\n'],
    ['a top-level message is not an envelope', '{"message":"top"}', '{"message":"top"}\n'],
    ['an array falls back to the raw body', '[{"error":{"message":"in array"}}]', '[{"error":{"message":"in array"}}]\n'],
    ['plain text is the message', 'plain text', 'plain text\n'],
    ['plain text keeps its whitespace', '\n  oops \n', '\n  oops \n\n'],
    ['an HTML page is the message, unescaped', '<html><body>502 &amp; more</body></html>', '<html><body>502 &amp; more</body></html>\n'],
    ['a blank body has a sentence of its own', '   \n', 'st-gateway returned an error with no message\n'],
    ['an empty body has a sentence of its own', '', 'st-gateway returned an error with no message\n'],
    ['a repeated key: the last message wins', '{"error":{"message":"first","message":"last"}}', 'last\n'],
    ['member names match case-insensitively', '{"ERROR":{"Message":"shouting"}}', 'shouting\n'],
  ];
  for (const [name, body, text] of cases) {
    it(name, async () => {
      assert.equal(await relayedBody(body), text);
    });
  }

  it('a raw body over 500 characters is cut to 500 characters', async () => {
    assert.equal(await relayedBody('x'.repeat(600)), `${'x'.repeat(500)}\n`);
    assert.equal(await relayedBody('x'.repeat(500)), `${'x'.repeat(500)}\n`);
    assert.equal(await relayedBody('x'.repeat(501)), `${'x'.repeat(500)}\n`);
  });

  it('the cut counts characters, not bytes: two-byte and four-byte ones are not split', async () => {
    assert.equal(await relayedBody('é'.repeat(600)), `${'é'.repeat(500)}\n`);
    assert.equal(await relayedBody('\u{1F600}'.repeat(600)), `${'\u{1F600}'.repeat(500)}\n`);
    assert.equal(await relayedBody('日本'.repeat(300)), `${'日本'.repeat(250)}\n`);
  });

  it('a message inside an envelope is not cut at all', async () => {
    const long = 'm'.repeat(5000);
    assert.equal(await relayedBody(JSON.stringify({ error: { message: long } })), `${long}\n`);
  });

  it('a body over 64 KiB is read only that far: an envelope cut in half is raw text', async () => {
    const body = `{"error":{"message":"${'y'.repeat(100_000)}"}}`;
    assert.equal(await relayedBody(body), `${body.slice(0, 500)}\n`);
  });

  it('a body over 64 KiB of plain text is cut to 500 characters', async () => {
    assert.equal(await relayedBody('z'.repeat(200_000)), `${'z'.repeat(500)}\n`);
  });

  it('a half-delivered error body is used as far as it came', async () => {
    gateway.on('GET', '/proxy/my/agent', { status: 500, behaviour: 'truncate' });
    const res = await call({ path: '/api/agent/v1/agent', headers: { Authorization: bearer(readerToken()) } });
    expectText(res, 500, '{"data":');
  });
});

describe('mapping the status', () => {
  const relayed = [400, 401, 402, 403, 404, 405, 406, 408, 409, 410, 413, 415, 418, 422, 425, 429, 431, 451, 499, 500, 501, 502, 503, 504, 505, 507, 511, 520, 599];
  for (const status of relayed) {
    it(`${status} is relayed with the gateway's sentence`, async () => {
      gateway.on('GET', '/proxy/my/agent', { status, json: { error: { message: `gateway says ${status}` } } });
      const res = await call({ path: '/api/agent/v1/agent', headers: { Authorization: bearer(readerToken()) } });
      expectText(res, status, `gateway says ${status}`);
    });
  }

  for (const status of [600, 650, 999]) {
    it(`${status} is outside 400-599: 502, still with the gateway's sentence`, async () => {
      gateway.on('GET', '/proxy/my/agent', { status, json: { error: { message: `gateway says ${status}` } } });
      const res = await call({ path: '/api/agent/v1/agent', headers: { Authorization: bearer(readerToken()) } });
      expectText(res, 502, `gateway says ${status}`);
    });
  }

  it('a gateway 401 reaches the caller as a text/plain 401, not as the auth envelope', async () => {
    gateway.on('GET', '/proxy/my/agent', { status: 401, json: { error: { message: 'Token reset_date does not match' } } });
    const res = await call({ path: '/api/agent/v1/agent', headers: { Authorization: bearer(readerToken()) } });
    expectText(res, 401, 'Token reset_date does not match');
  });
});

describe('a gateway that does not answer', () => {
  const sentence = 'st-gateway did not answer';

  it('a connection closed without a response is a 504', async () => {
    gateway.on('GET', '/proxy/my/agent', { behaviour: 'drop' });
    expectText(await call({ path: '/api/agent/v1/agent', headers: { Authorization: bearer(readerToken()) } }), 504, sentence);
  });

  it('a success body that dies half way is a 504', async () => {
    gateway.on('GET', '/proxy/my/agent', { status: 200, behaviour: 'truncate' });
    expectText(await call({ path: '/api/agent/v1/agent', headers: { Authorization: bearer(readerToken()) } }), 504, sentence);
  });

  it('a refused connection is a 504 on every route, and the gateway is reachable again afterwards', async () => {
    for (const route of upstreamRoutes(uid('DEAD'))) {
      expectText(await drive(route, 'refuse'), 504, sentence);
    }
    gateway.on('GET', '/proxy/my/agent', { json: p.data(p.agent()) });
    const res = await call({ path: '/api/agent/v1/agent', headers: { Authorization: bearer(readerToken()) } });
    assert.equal(res.status, 200);
  });

  it('a dead gateway never leaks its address', async () => {
    const res = await drive(upstreamRoutes(uid('DEAD'))[0]!, 'refuse');
    assert.ok(!res.text.includes(String(gateway.port)));
    assert.ok(!res.text.includes('connect'));
  });

  it('no history is written for a call that failed', async () => {
    const sym = uid('NOHIST');
    const route = upstreamRoutes(sym).find((r) => r.id === 'POST /ships/{shipSymbol}/sell')!;
    expectText(await drive(route, { status: 400, json: { error: { message: 'no' } } }), 400, 'no');
    gateway.clearScripts();
    const history = await call({ path: `/api/agent/v1/transactions?shipSymbol=${sym}` });
    assert.deepEqual(JSON.parse(history.text), []);
  });
});
