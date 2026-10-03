// HEAD on the GET routes: the same decision as GET, made by the same handler, with
// the body left off. A HEAD of a proxied route still calls the gateway, with GET.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { expectHeadOf } from '../harness/expect.ts';
import { API, bearer, call, center, gateway, readerToken, tokenFor, uid, writerToken } from '../harness/world.ts';
import * as p from '../fixtures/payloads.ts';
import { allRoutes, scriptUpstream } from '../fixtures/routes.ts';

describe('HEAD answers like GET without a body', () => {
  const templates = allRoutes('PROBE').filter((r) => r.method === 'GET' && !r.id.includes('swagger'));

  for (const template of templates) {
    describe(template.id, () => {
      const route = () => allRoutes(uid('HD')).find((r) => r.id === template.id)!;

      it('with a session', async () => {
        const r = route();
        scriptUpstream(gateway, r);
        const headers = { Authorization: bearer(writerToken()) };
        const get = await call({ path: r.path, headers });
        const head = await call({ method: 'HEAD', path: r.path, headers });
        assert.equal(get.status, 200);
        expectHeadOf(head, get);
      });

      if (template.tier === 'read' || template.tier === 'public') {
        it('without a session', async () => {
          const r = route();
          scriptUpstream(gateway, r);
          const get = await call({ path: r.path });
          const head = await call({ method: 'HEAD', path: r.path });
          expectHeadOf(head, get);
          assert.equal(head.status, template.tier === 'read' ? 401 : 200);
        });

        it('with a token the center calls inactive', async () => {
          const r = route();
          scriptUpstream(gateway, r);
          const token = tokenFor({ kind: 'inactive' });
          const head = await call({ method: 'HEAD', path: r.path, headers: { Authorization: bearer(token) } });
          assert.equal(head.status, 401);
          assert.equal(head.text, '');
          assert.equal(head.headers['content-type'], 'application/json');
        });

        it('with a center that fails', async () => {
          const r = route();
          scriptUpstream(gateway, r);
          const token = tokenFor({ kind: 'status', status: 500 });
          const head = await call({ method: 'HEAD', path: r.path, headers: { Authorization: bearer(token) } });
          assert.equal(head.status, 503);
          assert.equal(head.text, '');
        });
      }
    });
  }

  it('a HEAD of a proxied route calls the gateway with GET, once per call', async () => {
    const sym = uid('HD');
    gateway.on('GET', `/proxy/my/ships/${sym}`, { json: p.data(p.ship(sym)) });
    const head = await call({ method: 'HEAD', path: `${API}/ships/${sym}`, headers: { Authorization: bearer(readerToken()) } });
    assert.equal(head.status, 200);
    assert.equal(head.text, '');
    assert.deepEqual(
      gateway.requests.map((r) => `${r.method} ${r.url}`),
      [`GET /proxy/my/ships/${sym}`],
    );
    assert.equal(center.calls.length, 1);
  });

  it('a HEAD of /current-agent makes all three calls', async () => {
    const r = allRoutes(uid('HD')).find((x) => x.id === 'GET /current-agent')!;
    scriptUpstream(gateway, r);
    const head = await call({ method: 'HEAD', path: r.path, headers: { Authorization: bearer(readerToken()) } });
    assert.equal(head.status, 200);
    assert.equal(gateway.requests.length, 3);
  });

  it('relays an upstream error with its pacing headers and no body', async () => {
    gateway.on('GET', '/proxy/my/agent', {
      status: 429,
      json: { error: { message: 'slow down' } },
      headers: { 'Retry-After': '5', 'X-RateLimit-Remaining': '0' },
    });
    const headers = { Authorization: bearer(readerToken()) };
    const get = await call({ path: `${API}/agent`, headers });
    const head = await call({ method: 'HEAD', path: `${API}/agent`, headers });
    assert.equal(head.status, 429);
    expectHeadOf(head, get);
    assert.equal(head.headers['retry-after'], '5');
  });

  it('a validation error has no body either', async () => {
    const get = await call({ path: `${API}/transactions?limit=0` });
    const head = await call({ method: 'HEAD', path: `${API}/transactions?limit=0` });
    assert.equal(head.status, 400);
    expectHeadOf(head, get);
  });
});

describe('HEAD on a route that has no GET', () => {
  it('is a 404 for every POST-only route', async () => {
    for (const r of allRoutes('HEADX').filter((x) => x.method === 'POST')) {
      const path = r.path;
      if (r.id === 'POST /ships/purchase') continue; // /ships/purchase is the ship called "purchase" for a HEAD
      if (r.path.endsWith('/deliveries')) continue; // the same path has a GET
      assert.equal((await call({ method: 'HEAD', path, headers: { Authorization: bearer(writerToken()) } })).status, 404, path);
    }
    assert.deepEqual(center.calls, []);
  });

  it('HEAD /ships/purchase is a HEAD of the ship called "purchase"', async () => {
    gateway.on('GET', '/proxy/my/ships/purchase', { json: p.data(p.ship('purchase')) });
    const head = await call({ method: 'HEAD', path: `${API}/ships/purchase`, headers: { Authorization: bearer(readerToken()) } });
    assert.equal(head.status, 200);
  });
});
