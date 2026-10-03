// Path behaviour: which paths exist, what happens to the ones that do not, how
// percent-encoding and repeated slashes are treated, and what reaches the gateway.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { expectJson, expectNoBody, expectNotFound, relevantHeaders, TEXT_TYPE } from '../harness/expect.ts';
import { API, bearer, call, center, gateway, readerToken, uid, writerToken } from '../harness/world.ts';
import * as p from '../fixtures/payloads.ts';
import { allRoutes } from '../fixtures/routes.ts';

describe('unknown paths and wrong methods', () => {
  // Two different answers, depending on where the path is.
  //
  // Under /api/agent (a plain string prefix: /api/agentx counts too) the router
  // answers 404 "404 page not found" for every path no route takes and for every
  // wrong method on a route there, and never 405. Elsewhere it answers a bare 405,
  // because a catch-all OPTIONS route (the CORS preflight) matches every path and
  // so every other method reads as "the path exists, the method is wrong". Neither
  // answer carries CORS headers (the middleware only runs for a matched route),
  // and neither sets Allow.
  const bare405 = [
    '/',
    '/nope',
    '/api',
    '/api/',
    '/api/Agent/health',
    '/API/AGENT/V1/AGENT',
    '/Health',
    '/health/',
    '/health/extra',
    '/v1/agent',
    '/agent',
    '/ships',
    '/api/v1/agent',
  ];
  const notFound = [
    '/api/agent',
    '/api/agent/',
    '/api/agentx',
    '/api/agentx/health',
    '/api/agent/v1',
    '/api/agent/v1/',
    '/api/agent/v1/nope',
    '/api/agent/v2/agent',
    '/api/agent/v10/agent',
    '/api/agent/v1/agent/extra',
    '/api/agent/v1/ships/A/B',
    '/api/agent/v1/ships/A/B/C',
    '/api/agent/v1/contracts/A/B',
    '/api/agent/Health',
    '/api/agent/swagger',
    '/api/agent/health/extra',
    '/api/agent/agent',
  ];
  const methods = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH'];
  const bodyFor = (method: string) => (method === 'POST' || method === 'PUT' || method === 'PATCH' ? '{}' : undefined);

  for (const path of bare405) {
    for (const method of methods) {
      it(`${method} ${path} is a bare 405`, async () => {
        const res = await call({ method, path, headers: { Authorization: bearer(readerToken()) }, body: bodyFor(method) });
        expectNoBody(res, 405, { cors: false });
        assert.deepEqual(center.calls, [], 'an unmatched path never asks the center');
      });
    }
  }

  for (const path of notFound) {
    for (const method of methods) {
      it(`${method} ${path} is a 404 [net-http-text]`, async () => {
        const res = await call({ method, path, headers: { Authorization: bearer(readerToken()) }, body: bodyFor(method) });
        if (method === 'HEAD') {
          assert.equal(res.status, 404);
          assert.equal(res.text, '');
          assert.deepEqual(relevantHeaders(res), { 'content-type': TEXT_TYPE });
        } else {
          expectNotFound(res);
        }
        assert.deepEqual(center.calls, [], 'an unmatched path never asks the center');
      });
    }
  }

  it('a wrong method on /health is a bare 405, on /api/agent/health a 404 [net-http-text]', async () => {
    expectNoBody(await call({ method: 'DELETE', path: '/health' }), 405, { cors: false });
    expectNotFound(await call({ method: 'DELETE', path: '/api/agent/health' }));
  });

  it('a wrong method on any route under /api/agent is a 404 [net-http-text]', async () => {
    const token = writerToken();
    for (const r of allRoutes('SYM')) {
      const path = r.path.split('?')[0] as string;
      if (!path.startsWith('/api/agent/') || path.startsWith('/api/agent/swagger')) continue; // swagger: operational.ts
      const wrong = ['PUT', 'DELETE', 'PATCH'];
      // The other of GET and POST, unless the path has both (deliveries) or the
      // other one is a different route (GET /ships/purchase is a ship).
      if (!path.endsWith('/deliveries') && r.id !== 'POST /ships/purchase') wrong.push(r.method === 'GET' ? 'POST' : 'GET');
      for (const method of wrong) {
        const res = await call({ method, path, headers: { Authorization: bearer(token) }, body: method === 'GET' ? undefined : '{}' });
        expectNotFound(res);
      }
    }
    assert.deepEqual(center.calls, []);
  });

  it('GET /ships/purchase is the ship called "purchase", not the purchase route', async () => {
    gateway.on('GET', '/proxy/my/ships/purchase', { json: p.data(p.ship('purchase')) });
    const res = await call({ path: `${API}/ships/purchase`, headers: { Authorization: bearer(readerToken()) } });
    expectJson(res, 200, p.ship('purchase'));
  });

  it('POST /ships/purchase/purchase buys cargo for the ship called "purchase"', async () => {
    gateway.on('POST', '/proxy/my/ships/purchase/purchase', {
      json: p.data(p.marketResult('purchase', 'IRON_ORE', 'PURCHASE', '2026-03-04T05:06:07Z')),
    });
    const res = await call({
      method: 'POST',
      path: `${API}/ships/purchase/purchase`,
      headers: { Authorization: bearer(writerToken()) },
      body: JSON.stringify({ symbol: 'IRON_ORE', units: 4 }),
    });
    assert.equal(res.status, 200);
  });
});

describe('trailing slashes', () => {
  // No route tolerates one: the router is not in "strict slash" mode and the
  // path simply does not match.
  const withSlash = [
    '/health/',
    '/api/agent/health/',
    '/api/agent/v1/agent/',
    '/api/agent/v1/ships/',
    '/api/agent/v1/ships/X/',
    '/api/agent/v1/contracts/',
    '/api/agent/v1/contracts/X/',
    '/api/agent/v1/contracts/X/deliveries/',
    '/api/agent/v1/transactions/',
    '/api/agent/v1/current-agent/',
    '/api/agent/v1/ships/X/sell/',
    '/api/agent/v1/ships/purchase/',
  ];
  for (const path of withSlash) {
    it(`GET ${path} is not the route without the slash [net-http-text]`, async () => {
      const res = await call({ path, headers: { Authorization: bearer(readerToken()) } });
      if (path.startsWith('/api/agent')) expectNotFound(res);
      else expectNoBody(res, 405, { cors: false });
      assert.deepEqual(center.calls, []);
    });
  }
});

describe('redirects for paths that are not clean', () => {
  // gorilla/mux cleans the (decoded) path before routing and answers 301 with the
  // cleaned path, for every method, before any middleware: no CORS headers, no
  // body, no credential check. The query string survives.
  const cases: Array<[string, string]> = [
    ['/api/agent//health', '/api/agent/health'],
    ['//health', '/health'],
    ['/api//agent//v1//agent', '/api/agent/v1/agent'],
    ['/api/agent/./health', '/api/agent/health'],
    ['/api/agent/v1/ships/../agent', '/api/agent/v1/agent'],
    ['/api/agent/v1/ships/%2E%2E/agent', '/api/agent/v1/agent'],
    ['/api/agent/v1/ships/%2e%2e', '/api/agent/v1'],
    ['/health/.', '/health'],
    ['/health/../health', '/health'],
    ['/api/agent//health?x=1&y=%20z', '/api/agent/health?x=1&y=%20z'],
    ['/api/agent/v1/transactions//?limit=5', '/api/agent/v1/transactions/?limit=5'],
    ['/../health', '/health'],
  ];
  for (const [path, location] of cases) {
    for (const method of ['GET', 'HEAD', 'POST', 'DELETE']) {
      it(`${method} ${path} -> 301 ${location}`, async () => {
        const res = await call({ method, path, headers: { Authorization: bearer(writerToken()) } });
        expectNoBody(res, 301, { cors: false, headers: { location } });
        assert.deepEqual(center.calls, []);
      });
    }
  }
});

describe('percent-decoding', () => {
  it('routes on the decoded path: %61gent is agent', async () => {
    gateway.on('GET', '/proxy/my/agent', { json: p.data(p.agent()) });
    const res = await call({ path: `${API}/%61gent`, headers: { Authorization: bearer(readerToken()) } });
    expectJson(res, 200, p.agent());
  });

  it('routes on the decoded path once: %2561gent is the path /%61gent, which no route has [net-http-text]', async () => {
    const res = await call({ path: `${API}/%2561gent`, headers: { Authorization: bearer(readerToken()) } });
    expectNotFound(res);
  });

  it('decodes the whole health path', async () => {
    expectJson(await call({ path: '/%68%65%61%6C%74%68' }), 200, { status: 'ok' });
    expectJson(await call({ path: '/api/agent/%68ealth' }), 200, { status: 'ok' });
  });

  it('an encoded slash is a slash: the segment splits and no route matches [net-http-text]', async () => {
    for (const path of [`${API}/ships/A%2FB`, `${API}/ships/A%2fB`, `${API}/contracts/A%2FB`, `${API}/ships/A%2FB/sell`]) {
      const res = await call({ method: path.endsWith('/sell') ? 'POST' : 'GET', path, headers: { Authorization: bearer(writerToken()) } });
      expectNotFound(res);
    }
  });

  it('a malformed percent escape is rejected by the HTTP layer itself [net-http-text]', async () => {
    for (const path of [`${API}/ships/%zz`, `${API}/ships/%`, `${API}/ships/%4`, '/%gg', `${API}/ships/A%2`]) {
      const res = await call({ path, headers: { Authorization: bearer(readerToken()) } });
      assert.equal(res.status, 400, path);
      assert.equal(res.headers['content-type'], TEXT_TYPE);
      assert.equal(res.text, '400 Bad Request');
      assert.deepEqual(relevantHeaders(res), { 'content-type': TEXT_TYPE });
    }
    assert.deepEqual(center.calls, []);
  });

  // Each segment a caller sends is decoded by the router and escaped again,
  // with the standard library's path-segment rules, for the gateway: ':' '=' '@'
  // '&' '$' '+' travel as they are; ',' ';' '?' '#' '%' space and everything
  // non-ASCII are escaped. An unescaped "../" would steer the gateway at a
  // different proxy path.
  const segments: Array<[sent: string, upstream: string]> = [
    ['plain-Segment_1.x~', 'plain-Segment_1.x~'],
    ['A%20B', 'A%20B'],
    ['A+B', 'A+B'],
    ['A%2BB', 'A+B'],
    ['a%3Ab', 'a:b'],
    ['a%3Db', 'a=b'],
    ['a%40b', 'a@b'],
    ['a%26b', 'a&b'],
    ['a%24b', 'a$b'],
    ['a%2Cb', 'a%2Cb'],
    ['a%3Bb', 'a%3Bb'],
    ['a%3Fb', 'a%3Fb'],
    ['a%23b', 'a%23b'],
    ['a%25b', 'a%25b'],
    ['a%5Cb', 'a%5Cb'],
    ['a%22b', 'a%22b'],
    ['a%3Cb%3E', 'a%3Cb%3E'],
    ['%C3%A9', '%C3%A9'],
    ['%e2%82%ac', '%E2%82%AC'],
    ['a%7Cb', 'a%7Cb'],
    ['a%7Eb', 'a~b'],
    ['a%41', 'aA'],
  ];

  for (const [sent, upstream] of segments) {
    it(`GET /ships/${sent} asks the gateway for /my/ships/${upstream}`, async () => {
      gateway.on('GET', `/proxy/my/ships/${upstream}`, { json: p.data(p.ship('X')) });
      const res = await call({ path: `${API}/ships/${sent}`, headers: { Authorization: bearer(readerToken()) } });
      expectJson(res, 200, p.ship('X'));
      assert.equal(gateway.requests.length, 1);
    });

    it(`POST /contracts/${sent}/accept asks the gateway for /my/contracts/${upstream}/accept`, async () => {
      gateway.on('POST', `/proxy/my/contracts/${upstream}/accept`, { json: p.data(p.contractAndAgent('X', true)) });
      const res = await call({ method: 'POST', path: `${API}/contracts/${sent}/accept`, headers: { Authorization: bearer(writerToken()) } });
      expectJson(res, 200, p.contractAndAgent('X', true));
    });
  }

  it('GET /contracts/{id}/deliveries decodes the id before it reaches MySQL', async () => {
    const id = uid('DEC');
    const written = await call({
      method: 'POST',
      path: `${API}/contracts/${id}%20x/deliveries`,
      headers: { Authorization: bearer(writerToken()) },
      body: JSON.stringify({ shipSymbol: 'S', tradeSymbol: 'T', units: 1 }),
    });
    assert.equal(written.status, 200);
    assert.equal((JSON.parse(written.text) as { contractId: string }).contractId, `${id} x`);
    const read = await call({ path: `${API}/contracts/${id}%20x/deliveries` });
    assert.equal(read.status, 200);
    assert.equal((JSON.parse(read.text) as unknown[]).length, 1);
  });
});

describe('query strings', () => {
  it('are ignored on routes that do not read them and never forwarded to the gateway', async () => {
    gateway.on('GET', '/proxy/my/agent', { json: p.data(p.agent()) });
    expectJson(
      await call({ path: `${API}/agent?limit=5&x=%zz&y`, headers: { Authorization: bearer(readerToken()) } }),
      200,
      p.agent(),
    );
    assert.equal(gateway.requests[0]?.url, '/proxy/my/agent');
  });
});
