// Entry point. `node --test` runs this one file, in one process, against one
// service instance: the stubs live in this process, so splitting the suites over
// several test files (several processes) would need a service per file.
//
// What is under test is named by the environment:
//   CONTRACT_IMAGE    docker image to run (the normal way)
//   CONTRACT_COMMAND  or: a shell command that starts a local process
//   CONTRACT_MYSQL_*  where the service finds MySQL (see README.md)

import { after, afterEach, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { destroyAgent } from './harness/http.ts';
import { startService, stopEverything, saveLog } from './harness/service.ts';
import { center, gateway, world } from './harness/world.ts';

before(async () => {
  await gateway.start();
  await center.start();
  world.service = await startService({
    gateway: gateway.port,
    center: center.port,
    centerSecret: center.secret,
  });
});

after(async () => {
  try {
    if (world.service !== undefined) saveLog('service.log', await world.service.logs());
  } finally {
    destroyAgent();
    await stopEverything();
    await gateway.stop();
    await center.stop();
  }
});

beforeEach(() => {
  gateway.reset();
  center.reset();
});

afterEach(() => {
  // A request nobody scripted means the test did not know what the service
  // would call, which is a defect in the test, however it ended.
  assert.deepEqual(
    gateway.unscripted.map((r) => `${r.method} ${r.url}`),
    [],
    'the service called st-gateway with nothing scripted for it',
  );
  assert.deepEqual(center.strays, [], 'the service called the introspection center somewhere else than its endpoint');
});

import './suites/pins.ts';
import './suites/operational.ts';
import './suites/routing.ts';
import './suites/cors.ts';
import './suites/auth.ts';
import './suites/proxy.ts';
import './suites/upstream-errors.ts';
import './suites/validation.ts';
import './suites/persistence.ts';
import './suites/head.ts';
import './suites/startup.ts';
