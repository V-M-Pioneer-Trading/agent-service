// Health and Swagger: the two "ignore" routes. They never read the Authorization
// header and never call the introspection center, so they keep answering while
// auth-service is down.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { expectHeadOf, expectJson, expectNoBody, expectNotFound } from '../harness/expect.ts';
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
      it(`${method} ${path} is a 404: under /api/agent a wrong method is never a 405 [net-http-text]`, async () => {
        const res = await call({ method, path, body: method === 'POST' ? '{}' : undefined });
        if (path === '/health') expectNoBody(res, 405, { cors: false });
        else expectNotFound(res);
      });
    }
  }
});

describe('swagger', () => {
  // The docs UI is a third-party handler, so only what a reader of the docs
  // depends on is pinned: the docs route answers 2xx or 3xx; following its
  // redirects ends on an HTML page; the spec that page loads is JSON; and the
  // introspection center is never asked. How it redirects, what it says to HEAD
  // and POST, and the page's markup are the library's business.
  const DOCS = '/api/agent/swagger/';

  /** GET a path and follow redirects (at most five), as a browser would. */
  async function open(path: string) {
    let current = path;
    for (let hop = 0; hop < 5; hop++) {
      const res = await call({ path: current });
      const location = res.headers['location'];
      if (res.status >= 300 && res.status < 400 && typeof location === 'string') {
        current = new URL(location, `http://placeholder${current}`).pathname;
        continue;
      }
      return { res, finalPath: current };
    }
    throw new Error(`${path}: too many redirects`);
  }

  it('the docs route answers 2xx or 3xx', async () => {
    const res = await call({ path: DOCS });
    assert.ok(res.status >= 200 && res.status < 400, `status ${res.status}`);
  });

  it('the docs UI page is reachable: following redirects ends in 200 text/html', async () => {
    const { res } = await open(DOCS);
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type']), /^text\/html/);
    assert.ok(res.body.length > 0);
  });

  it('the spec the UI page loads is JSON', async (t) => {
    const { res: page, finalPath } = await open(DOCS);
    const m = /\burl:\s*["']([^"']+)["']/.exec(page.text);
    if (m === null || m[1] === undefined) {
      t.skip('the UI page names no spec URL (it may bundle the spec); only its reachability is pinned');
      return;
    }
    const spec = await open(new URL(m[1], `http://placeholder${finalPath}`).pathname);
    assert.equal(spec.res.status, 200);
    assert.match(String(spec.res.headers['content-type']), /^application\/json/);
    assert.equal(typeof (JSON.parse(spec.res.text) as { paths?: unknown }).paths, 'object');
  });

  it('never reads credentials or asks the center', async () => {
    const hanging = tokenFor({ kind: 'hang' });
    for (const authorization of [bearer(hanging), 'Bearer', 'garbage']) {
      const { res } = await open(DOCS);
      assert.equal(res.status, 200);
      const direct = await call({ path: DOCS, headers: { Authorization: authorization } });
      assert.ok(direct.status < 400);
    }
    assert.deepEqual(center.calls, []);
  });
});
