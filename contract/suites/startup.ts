// Configuration: what the service refuses to start with, and the two settings
// that have defaults or are normalised (CORS_ALLOWED_ORIGIN, ST_GATEWAY_URL).
//
// These start further instances, each against the same MySQL and stubs as the
// main one. The refusals are checked by exit code only: the log line that
// explains them is the operator's, not the API's.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { send } from '../harness/http.ts';
import type { RunningService } from '../harness/service.ts';
import { defaultEnv, runToExit, startService } from '../harness/service.ts';
import { bearer, center, gateway, readerToken } from '../harness/world.ts';
import * as p from '../fixtures/payloads.ts';

function stubs() {
  return { gateway: gateway.port, center: center.port, centerSecret: center.secret };
}

async function withService<T>(env: Record<string, string | undefined>, fn: (svc: RunningService) => Promise<T>): Promise<T> {
  const svc = await startService(stubs(), { env });
  try {
    return await fn(svc);
  } finally {
    await svc.stop();
  }
}

describe('configuration the service refuses', () => {
  // AUTH_INTROSPECTION_URL and _SECRET are required, and a bad one must stop the
  // process before it listens: a service that started without them would answer
  // 503 to every request and look like an outage of auth-service.
  const refused: Array<[name: string, env: Record<string, string | undefined>]> = [
    ['no AUTH_INTROSPECTION_URL', { AUTH_INTROSPECTION_URL: undefined }],
    ['an empty AUTH_INTROSPECTION_URL', { AUTH_INTROSPECTION_URL: '' }],
    ['a blank AUTH_INTROSPECTION_URL', { AUTH_INTROSPECTION_URL: '   ' }],
    ['no AUTH_INTROSPECTION_SECRET', { AUTH_INTROSPECTION_SECRET: undefined }],
    ['an empty AUTH_INTROSPECTION_SECRET', { AUTH_INTROSPECTION_SECRET: '' }],
    ['a blank AUTH_INTROSPECTION_SECRET', { AUTH_INTROSPECTION_SECRET: '   ' }],
    ['a secret with a leading space', { AUTH_INTROSPECTION_SECRET: ' secret' }],
    ['a secret with a trailing space', { AUTH_INTROSPECTION_SECRET: 'secret ' }],
    ['a secret with a control character', { AUTH_INTROSPECTION_SECRET: 'sec\tret' }],
    ['a URL that is not a URL', { AUTH_INTROSPECTION_URL: 'not a url' }],
    ['a URL without a scheme', { AUTH_INTROSPECTION_URL: 'localhost:3005/auth/v1/introspect' }],
    ['a relative URL', { AUTH_INTROSPECTION_URL: '/auth/v1/introspect' }],
    ['a URL with another scheme', { AUTH_INTROSPECTION_URL: 'ftp://center.internal/auth/v1/introspect' }],
    ['a URL without a host', { AUTH_INTROSPECTION_URL: 'http:///auth/v1/introspect' }],
    ['a URL with credentials', { AUTH_INTROSPECTION_URL: 'http://user:pw@center.internal/auth/v1/introspect' }],
    ['a URL with a user name only', { AUTH_INTROSPECTION_URL: 'http://user@center.internal/auth/v1/introspect' }],
    ['a URL with a query', { AUTH_INTROSPECTION_URL: 'http://center.internal/auth/v1/introspect?x=1' }],
    ['a URL with an empty query', { AUTH_INTROSPECTION_URL: 'http://center.internal/auth/v1/introspect?' }],
    ['a URL with a fragment', { AUTH_INTROSPECTION_URL: 'http://center.internal/auth/v1/introspect#x' }],
  ];

  for (const [name, env] of refused) {
    it(`${name}: the process exits with status 1`, async () => {
      const outcome = await runToExit(stubs(), { env });
      assert.equal(outcome.code, 1, outcome.output);
    });
  }

  it('the refusal never echoes the secret', async () => {
    const outcome = await runToExit(stubs(), { env: { AUTH_INTROSPECTION_SECRET: ' padded-secret-value ' } });
    assert.equal(outcome.code, 1);
    assert.ok(!outcome.output.includes('padded-secret-value'), 'the log must not contain the secret');
  });
});

describe('CORS_ALLOWED_ORIGIN', () => {
  for (const [name, value] of [
    ['unset', undefined],
    ['empty', ''],
  ] as const) {
    it(`${name}: the origin is http://localhost:3000`, async () => {
      await withService({ CORS_ALLOWED_ORIGIN: value }, async (svc) => {
        const res = await send(svc.baseUrl, { method: 'OPTIONS', path: '/health' });
        assert.equal(res.status, 204);
        assert.equal(res.headers['access-control-allow-origin'], 'http://localhost:3000');
      });
    });
  }

  it('is used verbatim, and not matched against the caller\'s Origin', async () => {
    await withService({ CORS_ALLOWED_ORIGIN: '*' }, async (svc) => {
      const res = await send(svc.baseUrl, { path: '/health', headers: { Origin: 'https://other.example.test' } });
      assert.equal(res.headers['access-control-allow-origin'], '*');
    });
  });
});

describe('ST_GATEWAY_URL', () => {
  const base = () => defaultEnv(stubs()).ST_GATEWAY_URL as string;

  async function agentThrough(url: string, target: string) {
    gateway.on('GET', target, { json: p.data(p.agent()) });
    return withService({ ST_GATEWAY_URL: url }, (svc) =>
      send(svc.baseUrl, { path: '/api/agent/v1/agent', headers: { Authorization: bearer(readerToken()) } }),
    );
  }

  it('a trailing slash is trimmed, so the path is /proxy/... and not //proxy/...', async () => {
    const res = await agentThrough(`${base()}/`, '/proxy/my/agent');
    assert.equal(res.status, 200, res.text);
  });

  it('any number of trailing slashes are trimmed', async () => {
    const res = await agentThrough(`${base()}////`, '/proxy/my/agent');
    assert.equal(res.status, 200, res.text);
  });

  it('a path in the URL is kept as a prefix', async () => {
    const res = await agentThrough(`${base()}/prefix/`, '/prefix/proxy/my/agent');
    assert.equal(res.status, 200, res.text);
  });
});
