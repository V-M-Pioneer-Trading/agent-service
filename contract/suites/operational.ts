// Health and Swagger: the two "ignore" routes. They never read the Authorization
// header and never call the introspection center, so they keep answering while
// auth-service is down.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CORS_HEADERS, expectHeadOf, expectJson, expectNoBody, expectNotFound, relevantHeaders } from '../harness/expect.ts';
import { bearer, call, center, tokenFor } from '../harness/world.ts';

const HEALTH_PATHS = ['/health', '/api/agent/health'];

describe('health', () => {
  for (const path of HEALTH_PATHS) {
    it(`GET ${path} answers {"status":"ok"}`, async () => {
      expectJson(await call({ path }), 200, { status: 'ok' });
    });

    it(`HEAD ${path} answers like GET without a body`, async () => {
      expectHeadOf(await call({ method: 'HEAD', path }), await call({ path }));
    });

    it(`GET ${path} never reads credentials or asks the center`, async () => {
      const hanging = tokenFor({ kind: 'hang' });
      const inactive = tokenFor({ kind: 'inactive' });
      for (const authorization of [bearer(hanging), bearer(inactive), 'Bearer', 'Basic Zm9vOmJhcg==', 'garbage']) {
        expectJson(await call({ path, headers: { Authorization: authorization } }), 200, { status: 'ok' });
      }
      const dup = await call({ path, headers: { Authorization: ['Bearer a', 'Bearer b'] } });
      expectJson(dup, 200, { status: 'ok' });
      assert.deepEqual(center.calls, []);
    });

    it(`${path} ignores the query string`, async () => {
      expectJson(await call({ path: `${path}?x=1&y=2` }), 200, { status: 'ok' });
    });

    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      it(`${method} ${path} is a 404: under /api/agent a wrong method is never a 405`, async () => {
        const res = await call({ method, path, body: method === 'POST' ? '{}' : undefined });
        if (path === '/health') expectNoBody(res, 405, { cors: false });
        else expectNotFound(res);
      });
    }
  }
});

describe('swagger', () => {
  // The UI is a third-party handler mounted on the prefix /api/agent/swagger/. It
  // sends its own answers, so these are the library's, not the service's: the bare
  // prefix redirects to index.html (a 301, not a 200), and a HEAD is refused (405,
  // with the CORS headers, because the service's middleware had already run).
  it('GET /api/agent/swagger/ redirects to index.html', async () => {
    const res = await call({ path: '/api/agent/swagger/' });
    assert.equal(res.status, 301);
    assert.equal(res.headers['location'], '/api/agent/swagger/index.html');
    assert.match(String(res.headers['content-type']), /^text\/html/);
    const { 'content-type': _type, location: _location, ...rest } = relevantHeaders(res);
    assert.deepEqual(rest, CORS_HEADERS);
  });

  it('GET /api/agent/swagger/index.html answers 200 with an HTML page', async () => {
    const res = await call({ path: '/api/agent/swagger/index.html' });
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type']), /^text\/html/);
    const { 'content-type': _type, ...rest } = relevantHeaders(res);
    assert.deepEqual(rest, CORS_HEADERS);
    assert.ok(res.body.length > 0);
  });

  it('GET /api/agent/swagger/doc.json answers 200 with JSON', async () => {
    const res = await call({ path: '/api/agent/swagger/doc.json' });
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type']), /^application\/json/);
    assert.equal(typeof (JSON.parse(res.text) as { paths?: unknown }).paths, 'object');
  });

  for (const path of ['/api/agent/swagger/', '/api/agent/swagger/index.html']) {
    it(`HEAD ${path} is refused with a 405 that carries the CORS headers`, async () => {
      const head = await call({ method: 'HEAD', path });
      assert.equal(head.status, 405);
      assert.equal(head.text, '');
      assert.deepEqual(relevantHeaders(head), { 'content-type': 'text/plain; charset=utf-8', ...CORS_HEADERS });
    });

    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      it(`${method} ${path} is a bare 405`, async () => {
        expectNoBody(await call({ method, path, body: method === 'POST' ? '{}' : undefined }), 405, { cors: false });
      });
    }
  }

  it('never reads credentials or asks the center', async () => {
    const hanging = tokenFor({ kind: 'hang' });
    for (const authorization of [bearer(hanging), 'Bearer', 'garbage']) {
      const res = await call({ path: '/api/agent/swagger/index.html', headers: { Authorization: authorization } });
      assert.equal(res.status, 200);
    }
    assert.deepEqual(center.calls, []);
  });

  it('is only the prefix with its trailing slash', async () => {
    expectNotFound(await call({ path: '/api/agent/swagger' }));
  });
});
