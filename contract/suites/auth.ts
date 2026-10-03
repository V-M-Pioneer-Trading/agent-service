// Route-level authorisation: what each tier asks of the Authorization header and
// of auth-service's answer, and what the service says when it refuses.
//
// The decision-21 policy has its own conformance suite in every language
// (introspection.json). This one pins what a caller of the HTTP API sees, on
// every route, and the request the service makes to the center.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { expectAuthError, expectJson, MSG } from '../harness/expect.ts';
import type { CenterBehaviour } from '../harness/stubs.ts';
import { API, bearer, call, center, gateway, readerToken, tokenFor, uid, writerToken } from '../harness/world.ts';
import * as p from '../fixtures/payloads.ts';
import { allRoutes, localRoutes, scriptUpstream, upstreamRoutes } from '../fixtures/routes.ts';

function bodyOf(route: { body?: unknown }): string | undefined {
  return route.body === undefined ? undefined : JSON.stringify(route.body);
}

describe('tiers, per route', () => {
  const sym = 'AUTH-SYM';
  const routes = [...upstreamRoutes(sym), ...localRoutes(sym)].filter((r) => r.tier === 'read' || r.tier === 'write');

  for (const r of routes) {
    describe(r.id, () => {
      it('no Authorization header: 401, and nobody else is asked', async () => {
        const res = await call({ method: r.method, path: r.path, body: bodyOf(r) });
        expectAuthError(res, 401, MSG.missingToken);
        assert.deepEqual(center.calls, []);
        assert.deepEqual(gateway.requests, []);
      });

      it('a token the center calls inactive: 401 invalid or expired session', async () => {
        const token = tokenFor({ kind: 'inactive' });
        const res = await call({ method: r.method, path: r.path, headers: { Authorization: bearer(token) }, body: bodyOf(r) });
        expectAuthError(res, 401, MSG.invalidSession);
        assert.equal(center.callsFor(token).length, 1);
        assert.deepEqual(gateway.requests, []);
      });

      it('a token the center has never heard of: 401 invalid or expired session', async () => {
        const res = await call({
          method: r.method,
          path: r.path,
          headers: { Authorization: bearer(center.unknownToken()) },
          body: bodyOf(r),
        });
        expectAuthError(res, 401, MSG.invalidSession);
      });

      it('a center that fails: 503, never its own status', async () => {
        const token = tokenFor({ kind: 'status', status: 500 });
        const res = await call({ method: r.method, path: r.path, headers: { Authorization: bearer(token) }, body: bodyOf(r) });
        expectAuthError(res, 503, MSG.centerUnavailable);
        assert.deepEqual(gateway.requests, []);
      });

      if (r.tier === 'write') {
        it('a valid session without fleet:control: 403, before the body is read', async () => {
          for (const body of [bodyOf(r), 'not json', '{']) {
            const token = tokenFor({ kind: 'active', scope: 'fleet:read other' });
            const res = await call({ method: r.method, path: r.path, headers: { Authorization: bearer(token) }, body });
            expectAuthError(res, 403, MSG.missingScope);
          }
          assert.deepEqual(gateway.requests, []);
        });

        it('an invalid body without a session is a 401, not a 400', async () => {
          const res = await call({ method: r.method, path: r.path, body: 'not json' });
          expectAuthError(res, 401, MSG.missingToken);
        });
      } else {
        it('a session with no scopes at all is enough', async () => {
          scriptUpstream(gateway, r);
          const res = await call({ method: r.method, path: r.path, headers: { Authorization: bearer(readerToken()) } });
          assert.equal(res.status, 200);
        });

        it('a session with unrelated scopes is enough', async () => {
          scriptUpstream(gateway, r);
          const token = tokenFor({ kind: 'active', scope: 'something:else' });
          const res = await call({ method: r.method, path: r.path, headers: { Authorization: bearer(token) } });
          assert.equal(res.status, 200);
        });
      }
    });
  }
});

describe('what counts as a credential', () => {
  const NO_CREDENTIAL: Array<[string, string | string[]]> = [
    ['an empty header', ''],
    ['the scheme alone', 'Bearer'],
    ['the scheme and a space', 'Bearer '],
    ['another scheme', 'Basic Zm9vOmJhcg=='],
    ['a bare token', 'abcdef'],
    ['a scheme glued to the token', 'Bearerabc'],
    ['two tokens', 'Bearer abc def'],
    ['three parts', 'Bearer abc def ghi'],
    ['a token scheme', 'Token abc'],
    ['two Authorization lines', ['Bearer abc', 'Bearer def']],
    ['two lines, the second empty', ['Bearer abc', '']],
  ];

  describe('on a read route, none of these is one (401 without asking the center)', () => {
    for (const [name, value] of NO_CREDENTIAL) {
      it(name, async () => {
        const res = await call({ path: `${API}/agent`, headers: { Authorization: value } });
        expectAuthError(res, 401, MSG.missingToken);
        assert.deepEqual(center.calls, []);
      });
    }
  });

  describe('on a public route, none of these is one either: the caller is a visitor', () => {
    for (const [name, value] of NO_CREDENTIAL) {
      it(name, async () => {
        const res = await call({ path: `${API}/transactions?shipSymbol=${uid('VIS')}`, headers: { Authorization: value } });
        expectJson(res, 200, []);
        assert.deepEqual(center.calls, []);
      });
    }
  });

  describe('on a write route, none of these is one (401)', () => {
    for (const [name, value] of NO_CREDENTIAL) {
      it(name, async () => {
        const res = await call({ method: 'POST', path: `${API}/contracts/X/accept`, headers: { Authorization: value } });
        expectAuthError(res, 401, MSG.missingToken);
        assert.deepEqual(center.calls, []);
      });
    }
  });

  describe('the scheme is case-insensitive and the whitespace is not part of the token', () => {
    for (const make of [(t: string) => `Bearer ${t}`, (t: string) => `bearer ${t}`, (t: string) => `BEARER ${t}`, (t: string) => `bEaReR ${t}`, (t: string) => `Bearer    ${t}`, (t: string) => `Bearer\t${t}`]) {
      it(JSON.stringify(make('T')), async () => {
        const token = readerToken();
        const header = make(token);
        gateway.on('GET', '/proxy/my/agent', { json: p.data(p.agent()) });
        const res = await call({ path: `${API}/agent`, headers: { Authorization: header } });
        expectJson(res, 200, p.agent());
        assert.equal(center.callsFor(token).length, 1, 'the center is asked about the bare token');
        assert.equal(gateway.requests[0]?.headers['authorization'], header, 'the header is forwarded verbatim');
      });
    }
  });
});

describe('public routes with a presented token', () => {
  const path = (sym: string) => `${API}/transactions?shipSymbol=${sym}`;

  it('a visitor is served and nobody is asked', async () => {
    expectJson(await call({ path: path(uid('PUB')) }), 200, []);
    assert.deepEqual(center.calls, []);
  });

  it('a bad token is a 401, never a visitor', async () => {
    const res = await call({ path: path(uid('PUB')), headers: { Authorization: bearer(tokenFor({ kind: 'inactive' })) } });
    expectAuthError(res, 401, MSG.invalidSession);
  });

  it('a token the center cannot judge is a 503, never a visitor', async () => {
    const res = await call({ path: path(uid('PUB')), headers: { Authorization: bearer(tokenFor({ kind: 'status', status: 502 })) } });
    expectAuthError(res, 503, MSG.centerUnavailable);
  });

  it('a good token, with or without scopes, is served', async () => {
    expectJson(await call({ path: path(uid('PUB')), headers: { Authorization: bearer(readerToken()) } }), 200, []);
    expectJson(await call({ path: path(uid('PUB')), headers: { Authorization: bearer(writerToken()) } }), 200, []);
  });

  it('GET /contracts/{id}/deliveries behaves the same', async () => {
    const id = uid('PUB');
    expectJson(await call({ path: `${API}/contracts/${id}/deliveries` }), 200, []);
    expectAuthError(
      await call({ path: `${API}/contracts/${id}/deliveries`, headers: { Authorization: bearer(tokenFor({ kind: 'inactive' })) } }),
      401,
      MSG.invalidSession,
    );
    expectAuthError(
      await call({ path: `${API}/contracts/${id}/deliveries`, headers: { Authorization: bearer(tokenFor({ kind: 'status', status: 500 })) } }),
      503,
      MSG.centerUnavailable,
    );
  });
});

describe('fleet:control', () => {
  // Exact membership of the scope list, split on runs of ASCII whitespace.
  const route = (sym: string) => ({
    method: 'POST',
    path: `${API}/contracts/${sym}/accept`,
    upstream: () => gateway.on('POST', `/proxy/my/contracts/${sym}/accept`, { json: p.data(p.contractAndAgent(sym, true)) }),
  });

  const accepted: Array<[string, string]> = [
    ['alone', 'fleet:control'],
    ['among others', 'a fleet:control b'],
    ['padded', '   fleet:control   '],
    ['separated by tabs and newlines', 'x\tfleet:control\ny'],
    ['separated by CR LF', 'x\r\nfleet:control\r\ny'],
    ['repeated', 'fleet:control fleet:control'],
  ];
  const refused: Array<[string, string | null | undefined]> = [
    ['absent', undefined],
    ['empty', ''],
    ['only blanks', '   '],
    ['a longer scope with the same prefix', 'fleet:control:read'],
    ['a shorter scope', 'fleet:contro'],
    ['a different case', 'FLEET:CONTROL'],
    ['a different case in one letter', 'fleet:Control'],
    ['a longer scope with the same suffix', 'xfleet:control'],
    ['a wildcard', 'fleet:*'],
    ['the namespace only', 'fleet'],
    ['joined by a non-breaking space (one opaque scope)', 'fleet:control x'],
    ['followed by an em space (one opaque scope)', 'fleet:control '],
    ['joined by a comma', 'fleet:control,other'],
  ];

  for (const [name, scope] of accepted) {
    it(`is satisfied ${name}`, async () => {
      const sym = uid('SC');
      const r = route(sym);
      r.upstream();
      const token = tokenFor({ kind: 'active', scope });
      const res = await call({ method: r.method, path: r.path, headers: { Authorization: bearer(token) } });
      assert.equal(res.status, 200);
    });
  }

  for (const [name, scope] of refused) {
    it(`is not satisfied when the scope is ${name}`, async () => {
      const r = route(uid('SC'));
      const token = tokenFor({ kind: 'active', scope });
      const res = await call({ method: r.method, path: r.path, headers: { Authorization: bearer(token) } });
      expectAuthError(res, 403, MSG.missingScope);
      assert.deepEqual(gateway.requests, []);
    });
  }

  it('is judged on the center\'s kind, which does not matter: a machine token with the scope is served', async () => {
    const sym = uid('SC');
    const r = route(sym);
    r.upstream();
    const token = tokenFor({ kind: 'active', subjectKind: 'machine', sub: 'user_machine', scope: 'fleet:control' });
    assert.equal((await call({ method: r.method, path: r.path, headers: { Authorization: bearer(token) } })).status, 200);
  });

  it('is judged on the center\'s kind, which does not matter: a machine token without it is refused', async () => {
    const r = route(uid('SC'));
    const token = tokenFor({ kind: 'active', subjectKind: 'machine', sub: 'user_machine', scope: 'other' });
    expectAuthError(await call({ method: r.method, path: r.path, headers: { Authorization: bearer(token) } }), 403, MSG.missingScope);
  });

  it('is required of every POST route, and of nothing else', async () => {
    for (const r of allRoutes(uid('SCOPE'))) {
      scriptUpstream(gateway, r);
      const token = tokenFor({ kind: 'active', scope: 'not-it' });
      const res = await call({ method: r.method, path: r.path, headers: { Authorization: bearer(token) }, body: bodyOf(r) });
      if (r.tier === 'write') assert.equal(res.status, 403, r.id);
      else assert.notEqual(res.status, 403, r.id);
    }
  });
});

describe('the center\'s answer', () => {
  const ok = { active: true, sub: 'user_x', exp: 4102444800, kind: 'operator' };
  const raw = (body: unknown, status = 200): CenterBehaviour => ({
    kind: 'raw',
    status,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

  const unavailable: Array<[string, CenterBehaviour]> = [
    ['a 500', { kind: 'status', status: 500 }],
    ['a 503', { kind: 'status', status: 503 }],
    ['a 502', { kind: 'status', status: 502 }],
    ['a 404', { kind: 'status', status: 404 }],
    ['a 400', { kind: 'status', status: 400 }],
    ['a 403', { kind: 'status', status: 403 }],
    ['a 401 about the service\'s own secret', { kind: 'status', status: 401, body: '{"error":{"message":"bad secret"}}' }],
    ['a 401 that says inactive', { kind: 'status', status: 401, body: '{"active":false}' }],
    ['a 5xx that carries a valid active answer', { kind: 'raw', status: 500, body: JSON.stringify(ok) }],
    ['a redirect', { kind: 'redirect', location: '/somewhere/else' }],
    ['a 204 with no body', { kind: 'raw', status: 204, body: '' }],
    ['an empty body', raw('')],
    ['a body that is not JSON', raw('not json')],
    ['an HTML error page', raw('<html><body>502 Bad Gateway</body></html>')],
    ['a JSON array', raw('[]')],
    ['a JSON string', raw('"active"')],
    ['null', raw('null')],
    ['an empty object', raw({})],
    ['active as a string', raw({ ...ok, active: 'true' })],
    ['active as null', raw({ ...ok, active: null })],
    ['active as a number', raw({ ...ok, active: 1 })],
    ['an active answer without sub', raw({ active: true, exp: 1, kind: 'operator' })],
    ['an active answer with an empty sub', raw({ ...ok, sub: '' })],
    ['an active answer with a numeric sub', raw({ ...ok, sub: 5 })],
    ['an active answer without exp', raw({ active: true, sub: 'u', kind: 'operator' })],
    ['an active answer with a string exp', raw({ ...ok, exp: '4102444800' })],
    ['an active answer without kind', raw({ active: true, sub: 'u', exp: 1 })],
    ['an unknown kind', raw({ ...ok, kind: 'admin' })],
    ['a kind in the wrong case', raw({ ...ok, kind: 'Operator' })],
    ['a null scope', raw({ ...ok, scope: null })],
    ['a numeric scope', raw({ ...ok, scope: 5 })],
    ['an array scope', raw({ ...ok, scope: ['fleet:control'] })],
    ['a contract key in the wrong case', raw('{"Active":true,"sub":"u","exp":1,"kind":"operator"}')],
    ['a contract key repeated', raw('{"active":false,"active":false}')],
    ['a contract key repeated in another case', raw('{"active":false,"Active":true}')],
    ['a key repeated in a nested object', raw('{"active":false,"other":{"a":1,"a":2}}')],
    ['trailing data after the object', raw('{"active":false} {}')],
    ['trailing garbage after the object', raw('{"active":false}x')],
    ['an answer over 64 KiB', raw(`{"active":false,"pad":"${'x'.repeat(70_000)}"}`)],
    ['an answer nested a thousand and one levels deep', raw(`{"active":false,"deep":${'['.repeat(1001)}${']'.repeat(1001)}}`)],
    ['a center that never answers', { kind: 'hang' }],
    ['a center slower than a second', { kind: 'delay', ms: 1600, then: { kind: 'active' } }],
  ];

  for (const [name, behaviour] of unavailable) {
    it(`${name}: 503, the one sentence for every failure`, async () => {
      const token = tokenFor(behaviour);
      const started = Date.now();
      const res = await call({ path: `${API}/agent`, headers: { Authorization: bearer(token) } });
      expectAuthError(res, 503, MSG.centerUnavailable);
      assert.deepEqual(gateway.requests, []);
      if (behaviour.kind === 'hang' || behaviour.kind === 'delay') {
        const elapsed = Date.now() - started;
        assert.ok(elapsed >= 900 && elapsed < 5000, `the center is given one second, took ${elapsed} ms`);
      }
    });
  }

  it('the same failures are 503 on a write route', async () => {
    for (const behaviour of [{ kind: 'status', status: 500 }, raw('not json'), { kind: 'hang' }] as CenterBehaviour[]) {
      const res = await call({ method: 'POST', path: `${API}/contracts/X/accept`, headers: { Authorization: bearer(tokenFor(behaviour)) } });
      expectAuthError(res, 503, MSG.centerUnavailable);
    }
  });

  const inactive: Array<[string, CenterBehaviour]> = [
    ['plain', { kind: 'inactive' }],
    ['with unknown members', raw('{"active":false,"extra":{"deep":[1,2,3]},"sub":5}')],
    ['whatever the content type says', { kind: 'raw', body: '{"active":false}', headers: { 'Content-Type': 'text/html' } }],
    ['with surrounding whitespace', raw('  \n{"active" : false}\n ')],
  ];
  for (const [name, behaviour] of inactive) {
    it(`an inactive answer ${name}: 401`, async () => {
      expectAuthError(
        await call({ path: `${API}/agent`, headers: { Authorization: bearer(tokenFor(behaviour)) } }),
        401,
        MSG.invalidSession,
      );
    });
  }

  const served: Array<[string, CenterBehaviour]> = [
    ['without a scope', { kind: 'active' }],
    ['with unknown members', { kind: 'active', extra: { client_id: 'x', nested: { a: [1, 2] } } }],
    ['with a 201', { kind: 'raw', status: 201, body: JSON.stringify(ok) }],
    ['with a float exp', raw({ ...ok, exp: 4102444800.5 })],
    ['with a negative exp', raw({ ...ok, exp: -1 })],
    ['with an expired exp (the center said active)', raw({ ...ok, exp: 1 })],
    ['of the machine kind', { kind: 'active', subjectKind: 'machine' }],
    ['after a short delay', { kind: 'delay', ms: 250, then: { kind: 'active' } }],
    ['with any content type', { kind: 'raw', body: JSON.stringify(ok), headers: { 'Content-Type': 'text/plain' } }],
  ];
  for (const [name, behaviour] of served) {
    it(`an active answer ${name}: the request is served`, async () => {
      gateway.on('GET', '/proxy/my/agent', { json: p.data(p.agent()) });
      const res = await call({ path: `${API}/agent`, headers: { Authorization: bearer(tokenFor(behaviour)) } });
      expectJson(res, 200, p.agent());
    });
  }

  it('a redirect is not followed', async () => {
    const token = tokenFor({ kind: 'redirect', location: '/elsewhere' });
    await call({ path: `${API}/agent`, headers: { Authorization: bearer(token) } });
    assert.equal(center.calls.length, 1);
    assert.deepEqual(center.strays, []);
  });
});

describe('the request to the center', () => {
  it('is one POST per inbound request, form encoded, with the secret in a header', async () => {
    const token = readerToken();
    gateway.on('GET', '/proxy/my/agent', { json: p.data(p.agent()) });
    await call({ path: `${API}/agent`, headers: { Authorization: bearer(token) } });
    assert.equal(center.calls.length, 1);
    const c = center.calls[0]!;
    assert.equal(c.method, 'POST');
    assert.equal(c.url, '/auth/v1/introspect');
    assert.equal(c.headers['content-type'], 'application/x-www-form-urlencoded');
    assert.equal(c.headers['accept'], 'application/json');
    assert.equal(c.headers['x-introspection-secret'], center.secret);
    assert.equal(c.body, `token=${token}`);
    assert.equal(c.headers['authorization'], undefined, 'the caller\'s header does not go to the center');
    assert.equal(c.headers['cookie'], undefined);
  });

  it('percent-encodes the token as a form value and sends nothing in the URL', async () => {
    const symbols = 'a+b/c=d~e.f-g_h:i%j';
    const token = center.token({ kind: 'active' }, symbols);
    gateway.on('GET', '/proxy/my/agent', { json: p.data(p.agent()) });
    await call({ path: `${API}/agent`, headers: { Authorization: bearer(token) } });
    const c = center.calls[0]!;
    assert.equal(c.url, '/auth/v1/introspect');
    assert.equal(c.body, `token=${encodeURIComponent(token)}`);
    assert.equal(new URLSearchParams(c.body).get('token'), token);
  });

  it('asks once for /current-agent, which calls the gateway three times', async () => {
    const token = readerToken();
    const route = upstreamRoutes('CUR').find((r) => r.id === 'GET /current-agent')!;
    scriptUpstream(gateway, route);
    const res = await call({ path: route.path, headers: { Authorization: bearer(token) } });
    assert.equal(res.status, 200);
    assert.equal(center.calls.length, 1);
    assert.equal(gateway.requests.length, 3);
  });

  it('asks once for a write, and not at all for the preflight that precedes it', async () => {
    const sym = uid('ONCE');
    const route = upstreamRoutes(sym).find((r) => r.id === 'POST /ships/{shipSymbol}/sell')!;
    scriptUpstream(gateway, route);
    await call({ method: 'OPTIONS', path: route.path });
    assert.equal(center.calls.length, 0);
    await call({ method: 'POST', path: route.path, headers: { Authorization: bearer(writerToken()) }, body: bodyOf(route) });
    assert.equal(center.calls.length, 1);
  });

  it('does not cache: the same token is asked about again', async () => {
    const token = readerToken();
    gateway.on('GET', '/proxy/my/agent', { json: p.data(p.agent()) });
    for (let i = 0; i < 3; i++) await call({ path: `${API}/agent`, headers: { Authorization: bearer(token) } });
    assert.equal(center.callsFor(token).length, 3);
  });

  it('does not retry a failure', async () => {
    const token = tokenFor({ kind: 'status', status: 500 });
    await call({ path: `${API}/agent`, headers: { Authorization: bearer(token) } });
    assert.equal(center.callsFor(token).length, 1);
  });

  it('is not made for anything that is refused before the header is read', async () => {
    await call({ method: 'DELETE', path: `${API}/agent`, headers: { Authorization: bearer(readerToken()) } });
    await call({ path: '/nowhere', headers: { Authorization: bearer(readerToken()) } });
    assert.deepEqual(center.calls, []);
  });
});

describe('what is forwarded to the gateway', () => {
  const forwardedForm = ['Bearer {t}', 'bearer {t}', 'Bearer    {t}'];

  for (const form of forwardedForm) {
    it(`Authorization ${JSON.stringify(form)} is forwarded verbatim by every upstream route`, async () => {
      for (const r of upstreamRoutes(uid('FWD'))) {
        gateway.clearScripts();
        scriptUpstream(gateway, r);
        const token = writerToken();
        const header = form.replace('{t}', token);
        const res = await call({ method: r.method, path: r.path, headers: { Authorization: header }, body: bodyOf(r) });
        assert.equal(res.status, 200, r.id);
        assert.equal(gateway.requests.length, r.upstream.length, r.id);
        for (const seen of gateway.requests) {
          assert.equal(seen.headers['authorization'], header, `${r.id}: ${seen.method} ${seen.url}`);
          assert.equal(seen.rawHeaders.filter((h) => h.toLowerCase() === 'authorization').length, 1);
        }
      }
    });
  }

  it('nothing else of the caller\'s is forwarded', async () => {
    for (const r of upstreamRoutes(uid('FWD'))) {
      gateway.clearScripts();
      scriptUpstream(gateway, r);
      const res = await call({
        method: r.method,
        path: r.path,
        headers: {
          Authorization: bearer(writerToken()),
          'X-Priority': 'interactive',
          Cookie: 'session=abc',
          'X-Forwarded-For': '203.0.113.9',
          'Proxy-Authorization': 'Basic Zm9v',
          Origin: 'https://app.example.test',
          'X-Request-Id': 'abc-123',
        },
        body: bodyOf(r),
      });
      assert.equal(res.status, 200, r.id);
      for (const seen of gateway.requests) {
        for (const name of ['x-priority', 'cookie', 'x-forwarded-for', 'proxy-authorization', 'origin', 'x-request-id', 'x-introspection-secret']) {
          assert.equal(seen.headers[name], undefined, `${r.id}: ${name}`);
        }
      }
    }
  });
});

describe('a center that refuses connections', () => {
  // Not a status code and not a hang: nothing is listening at all. Same single
  // 503 wherever a token has to be judged; routes that never ask are unaffected.
  async function refusing(fn: () => Promise<void>): Promise<void> {
    await center.refuse();
    try {
      await fn();
    } finally {
      await center.restore();
    }
  }

  it('a read route with a token is a 503', () =>
    refusing(async () => {
      const res = await call({ path: `${API}/agent`, headers: { Authorization: bearer(readerToken()) } });
      expectAuthError(res, 503, MSG.centerUnavailable);
      assert.deepEqual(gateway.requests, []);
    }));

  it('a write route with a token is a 503', () =>
    refusing(async () => {
      const res = await call({ method: 'POST', path: `${API}/contracts/X/accept`, headers: { Authorization: bearer(writerToken()) } });
      expectAuthError(res, 503, MSG.centerUnavailable);
    }));

  it('a public route with a token is a 503', () =>
    refusing(async () => {
      const res = await call({ path: `${API}/transactions?shipSymbol=${uid('RF')}`, headers: { Authorization: bearer(readerToken()) } });
      expectAuthError(res, 503, MSG.centerUnavailable);
    }));

  it('a public route without a token is still served', () =>
    refusing(async () => {
      expectJson(await call({ path: `${API}/transactions?shipSymbol=${uid('RF')}` }), 200, []);
    }));

  it('a read route without a token is a 401: nobody needs to be asked', () =>
    refusing(async () => {
      expectAuthError(await call({ path: `${API}/agent` }), 401, MSG.missingToken);
    }));

  it('health still answers 200', () =>
    refusing(async () => {
      for (const path of ['/health', '/api/agent/health']) expectJson(await call({ path }), 200, { status: 'ok' });
    }));

  it('and the center is used again once it is back', async () => {
    gateway.on('GET', '/proxy/my/agent', { json: p.data(p.agent()) });
    const res = await call({ path: `${API}/agent`, headers: { Authorization: bearer(readerToken()) } });
    expectJson(res, 200, p.agent());
  });
});
