// CORS: a preflight answered in front of everything, and the same four headers
// on every response a matched route produces.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CORS_HEADERS, expectAuthError, expectJson, expectNoBody, expectNotFound, expectText, MSG, relevantHeaders } from '../harness/expect.ts';
import { API, bearer, call, center, gateway, readerToken, tokenFor, uid, writerToken } from '../harness/world.ts';
import { allRoutes } from '../fixtures/routes.ts';

describe('CORS preflight', () => {
  const targets = [
    '/',
    '/health',
    '/api/agent/health',
    '/nope',
    `${API}/agent`,
    `${API}/ships/SYM`,
    `${API}/ships/purchase`,
    `${API}/ships/SYM/sell`,
    `${API}/contracts/SYM/accept`,
    `${API}/contracts/SYM/deliveries`,
    `${API}/transactions?limit=3`,
    '/api/agent/swagger/',
    `${API}/agent/`,
  ];

  for (const path of targets) {
    it(`OPTIONS ${path} is a 204 with the CORS headers and nothing else`, async () => {
      const res = await call({
        method: 'OPTIONS',
        path,
        headers: {
          Origin: 'https://app.example.test',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type, authorization',
        },
      });
      expectNoBody(res, 204);
      assert.deepEqual(center.calls, []);
      assert.deepEqual(gateway.requests, []);
    });
  }

  it('does not echo the caller\'s Origin, and answers a bare OPTIONS the same way', async () => {
    const evil = await call({ method: 'OPTIONS', path: `${API}/agent`, headers: { Origin: 'https://evil.example.test' } });
    const bare = await call({ method: 'OPTIONS', path: `${API}/agent` });
    assert.equal(evil.headers['access-control-allow-origin'], CORS_HEADERS['access-control-allow-origin']);
    assert.deepEqual(relevantHeaders(evil), relevantHeaders(bare));
  });

  it('does not read the Authorization header, valid or not', async () => {
    const hanging = tokenFor({ kind: 'hang' });
    for (const authorization of [bearer(hanging), 'Bearer', 'garbage']) {
      expectNoBody(await call({ method: 'OPTIONS', path: `${API}/ships/purchase`, headers: { Authorization: authorization } }), 204);
    }
    assert.deepEqual(center.calls, []);
  });

  it('ignores a request body', async () => {
    expectNoBody(await call({ method: 'OPTIONS', path: `${API}/agent`, body: '{"x":1}' }), 204);
  });

  it('a preflight to an unclean path is redirected first: the router cleans before it routes', async () => {
    const res = await call({ method: 'OPTIONS', path: '/api/agent//health' });
    expectNoBody(res, 301, { cors: false, headers: { location: '/api/agent/health' } });
  });

  it('exposes no credentials, max-age or vary headers', async () => {
    const res = await call({ method: 'OPTIONS', path: `${API}/agent`, headers: { Origin: 'https://app.example.test' } });
    for (const name of ['access-control-allow-credentials', 'access-control-max-age', 'vary']) {
      assert.equal(res.headers[name], undefined, name);
    }
  });
});

describe('CORS headers on ordinary responses', () => {
  it('are on the answer of every route (the swagger prefix answers a 301)', async () => {
    const sym = uid('CORS');
    for (const r of allRoutes(sym)) {
      for (const c of r.upstream) gateway.on(c.method, c.target, c.reply);
      const res = await call({
        method: r.method,
        path: r.path,
        headers: { Authorization: bearer(writerToken()) },
        body: r.body === undefined ? undefined : JSON.stringify(r.body),
      });
      if (r.id.includes('swagger')) {
        assert.equal(res.status, 301);
      } else {
        assert.equal(res.status, 200, r.id);
      }
      for (const [name, value] of Object.entries(CORS_HEADERS)) assert.equal(res.headers[name], value, `${r.id}: ${name}`);
    }
  });

  it('are on a 401', async () => {
    expectAuthError(await call({ path: `${API}/agent` }), 401, MSG.missingToken);
  });

  it('are on a 403', async () => {
    const token = readerToken();
    const res = await call({
      method: 'POST',
      path: `${API}/ships/purchase`,
      headers: { Authorization: bearer(token) },
      body: '{}',
    });
    expectAuthError(res, 403, MSG.missingScope);
  });

  it('are on a 503 from the center', async () => {
    const token = tokenFor({ kind: 'status', status: 500 });
    expectAuthError(await call({ path: `${API}/agent`, headers: { Authorization: bearer(token) } }), 503, MSG.centerUnavailable);
  });

  it('are on a relayed upstream error, next to the pacing headers', async () => {
    gateway.on('GET', '/proxy/my/agent', {
      status: 429,
      json: { error: { message: 'slow down' } },
      headers: { 'Retry-After': '7', 'X-RateLimit-Limit': '2', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '2026-01-01T00:00:00Z' },
    });
    const res = await call({ path: `${API}/agent`, headers: { Authorization: bearer(readerToken()) } });
    expectText(res, 429, 'slow down', {
      headers: {
        'retry-after': '7',
        'x-ratelimit-limit': '2',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '2026-01-01T00:00:00Z',
      },
    });
  });

  it('are on a validation error', async () => {
    const res = await call({ method: 'POST', path: `${API}/ships/purchase`, headers: { Authorization: bearer(writerToken()) }, body: '{' });
    assert.equal(res.status, 400);
    for (const [name, value] of Object.entries(CORS_HEADERS)) assert.equal(res.headers[name], value, name);
  });

  it('are on a public read', async () => {
    const res = await call({ path: `${API}/transactions?shipSymbol=${uid('NONE')}` });
    expectJson(res, 200, []);
  });

  it('are not on a 404, a 405, a redirect or a malformed-URL 400: the middleware never ran', async () => {
    expectNotFound(await call({ method: 'DELETE', path: `${API}/agent` }));
    expectNoBody(await call({ method: 'DELETE', path: '/health' }), 405, { cors: false });
    expectNoBody(await call({ path: '/api//agent' }), 301, { cors: false, headers: { location: '/api/agent' } });
    const bad = await call({ path: '/%zz' });
    assert.equal(bad.status, 400);
    assert.deepEqual(Object.keys(relevantHeaders(bad)).filter((n) => n.startsWith('access-control-')), []);
  });
});
