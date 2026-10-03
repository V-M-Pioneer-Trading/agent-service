// What the service remembers, observed only through its own API: purchases and
// sales through GET /transactions, deliveries through GET /contracts/{id}/deliveries.
//
// The history is best effort: it is written after the gateway call has already
// changed the game, so a failed write is logged and the caller still gets the
// gateway's answer. The tests below make MySQL refuse a row (a value too long for
// its column, a number too big for it) and watch the response stay whole and the
// row stay missing.
//
// Every test uses symbols nobody else uses, so the database may be shared and
// need not be empty.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

import { expectAuthError, expectJson, expectTextStartingWith, MSG } from '../harness/expect.ts';
import type { Recorded } from '../harness/stubs.ts';
import { API, bearer, call, gateway, readerToken, tokenFor, uid, writerToken } from '../harness/world.ts';
import * as p from '../fixtures/payloads.ts';
import { goPathEscape } from '../harness/util.ts';
import type { Json } from '../fixtures/payloads.ts';

const BASE = Date.parse('2026-03-04T05:06:07Z');

function iso(offsetSeconds: number): string {
  return new Date(BASE + offsetSeconds * 1000).toISOString().replace('.000Z', 'Z');
}

type Row = Record<string, Json>;

async function trade(
  action: 'purchase' | 'sell',
  ship: string,
  body: { symbol: string; units: number },
  upstream: Json,
): Promise<{ status: number; text: string }> {
  gateway.on('POST', `/proxy/my/ships/${goPathEscape(ship)}/${action}`, { json: p.data(upstream) });
  return call({
    method: 'POST',
    path: `${API}/ships/${encodeURIComponent(ship)}/${action}`,
    headers: { Authorization: bearer(writerToken()) },
    body: JSON.stringify(body),
  });
}

async function history(query: string): Promise<Row[]> {
  const res = await call({ path: `${API}/transactions?${query}` });
  assert.equal(res.status, 200, res.text);
  return JSON.parse(res.text) as Row[];
}

function sold(ship: string, at: string, over: Record<string, Json> = {}, credits = 175100): Record<string, Json> {
  return p.marketResult(ship, 'IRON_ORE', 'SELL', at, over, credits);
}

describe('history of cargo trades', () => {
  it('a purchase is recorded with exactly these members', async () => {
    const ship = uid('H');
    const res = await trade('purchase', ship, { symbol: 'IRON_ORE', units: 4 }, p.marketResult(ship, 'IRON_ORE', 'PURCHASE', iso(0)));
    assert.equal(res.status, 200);
    assert.deepEqual(await history(`shipSymbol=${ship}`), [
      {
        type: 'PURCHASE',
        shipSymbol: ship,
        waypointSymbol: 'X1-AB12-A1',
        tradeSymbol: 'IRON_ORE',
        units: 4,
        pricePerUnit: 25,
        totalPrice: 100,
        agentCredits: 175100,
        occurredAt: iso(0),
      },
    ]);
  });

  it('a sale is recorded with type SELL', async () => {
    const ship = uid('H');
    await trade('sell', ship, { symbol: 'IRON_ORE', units: 4 }, sold(ship, iso(0)));
    const rows = await history(`shipSymbol=${ship}`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!['type'], 'SELL');
  });

  it('a ship purchase is recorded with the ship type and without the cargo members', async () => {
    const ship = uid('H');
    gateway.on('POST', '/proxy/my/ships', { json: p.data(p.purchaseShipResult(ship, 'SHIP_PROBE', iso(0))) });
    const res = await call({
      method: 'POST',
      path: `${API}/ships/purchase`,
      headers: { Authorization: bearer(writerToken()) },
      body: JSON.stringify({ shipType: 'SHIP_REQUESTED', waypointSymbol: 'X1-REQUESTED' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await history(`shipSymbol=${ship}`), [
      {
        type: 'SHIP_PURCHASE',
        shipSymbol: ship,
        waypointSymbol: 'X1-AB12-C3',
        shipType: 'SHIP_PROBE',
        totalPrice: 55000,
        agentCredits: 120000,
        occurredAt: iso(0),
      },
    ]);
  });

  it('the ship comes from the path for cargo, and from the answer for a ship purchase', async () => {
    const ship = uid('H');
    const other = uid('H');
    await trade('sell', ship, { symbol: 'IRON_ORE', units: 4 }, sold(other, iso(0)));
    assert.equal((await history(`shipSymbol=${ship}`)).length, 1);
    assert.equal((await history(`shipSymbol=${other}`)).length, 0);
  });

  it('every value other than the ship comes from the gateway\'s answer, not the request', async () => {
    const ship = uid('H');
    await trade(
      'sell',
      ship,
      { symbol: 'REQUESTED', units: 99 },
      sold(ship, iso(0), { tradeSymbol: 'ANSWERED', units: 7, pricePerUnit: 11, totalPrice: 77, waypointSymbol: 'X1-ANSWERED' }, 4242),
    );
    assert.deepEqual(await history(`shipSymbol=${ship}`), [
      {
        type: 'SELL',
        shipSymbol: ship,
        waypointSymbol: 'X1-ANSWERED',
        tradeSymbol: 'ANSWERED',
        units: 7,
        pricePerUnit: 11,
        totalPrice: 77,
        agentCredits: 4242,
        occurredAt: iso(0),
      },
    ]);
  });

  it('zero units and a zero price are recorded as 0, not left out', async () => {
    const ship = uid('H');
    await trade('sell', ship, { symbol: 'X', units: 1 }, sold(ship, iso(0), { units: 0, pricePerUnit: 0, totalPrice: 0 }, 0));
    const [row] = await history(`shipSymbol=${ship}`);
    assert.equal(row!['units'], 0);
    assert.equal(row!['pricePerUnit'], 0);
    assert.equal(row!['totalPrice'], 0);
    assert.equal(row!['agentCredits'], 0);
  });

  it('money is 64-bit: credits and totals beyond 32 bits, and beyond 2^53, come back exactly', async () => {
    const ship = uid('H');
    await trade('sell', ship, { symbol: 'X', units: 1 }, sold(ship, iso(0), { totalPrice: 6_000_000_000 }, 5_000_000_000));
    const other = uid('H');
    gateway.on('POST', `/proxy/my/ships/${other}/sell`, {
      raw: JSON.stringify(p.data(sold(other, iso(0)))).replace('"credits":175100', '"credits":9007199254740993').replace('"totalPrice":100', '"totalPrice":9007199254740995'),
    });
    await call({ method: 'POST', path: `${API}/ships/${other}/sell`, headers: { Authorization: bearer(writerToken()) }, body: '{"symbol":"X","units":1}' });

    const [row] = await history(`shipSymbol=${ship}`);
    assert.equal(row!['agentCredits'], 5_000_000_000);
    assert.equal(row!['totalPrice'], 6_000_000_000);
    const big = await call({ path: `${API}/transactions?shipSymbol=${other}` });
    assert.match(big.text, /"agentCredits"\s*:\s*9007199254740993\b/);
    assert.match(big.text, /"totalPrice"\s*:\s*9007199254740995\b/);
  });

  it('negative credits are recorded', async () => {
    const ship = uid('H');
    await trade('sell', ship, { symbol: 'X', units: 1 }, sold(ship, iso(0), { totalPrice: -50 }, -10));
    const [row] = await history(`shipSymbol=${ship}`);
    assert.equal(row!['agentCredits'], -10);
    assert.equal(row!['totalPrice'], -50);
  });

  it('a value with characters that are not ASCII round-trips', async () => {
    const ship = uid('H');
    await trade('sell', ship, { symbol: 'X', units: 1 }, sold(ship, iso(0), { tradeSymbol: 'ÉÜ日本\u{1F600}', waypointSymbol: 'X1-é' }));
    const [row] = await history(`shipSymbol=${ship}`);
    assert.equal(row!['tradeSymbol'], 'ÉÜ日本\u{1F600}');
    assert.equal(row!['waypointSymbol'], 'X1-é');
  });

  it('a percent-encoded ship symbol is recorded decoded', async () => {
    const ship = `${uid('H')} spaced+plus`;
    await trade('sell', ship, { symbol: 'X', units: 1 }, sold(ship, iso(0)));
    const rows = await history(`shipSymbol=${encodeURIComponent(ship)}`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!['shipSymbol'], ship);
  });
});

describe('the time of a transaction', () => {
  const run = async (stamp: Json | undefined) => {
    const ship = uid('T');
    const result = sold(ship, iso(0));
    const tx = result['transaction'] as Record<string, Json>;
    if (stamp === undefined) delete tx['timestamp'];
    else tx['timestamp'] = stamp;
    const res = await trade('sell', ship, { symbol: 'X', units: 1 }, result);
    assert.equal(res.status, 200);
    return history(`shipSymbol=${ship}`);
  };

  it('the gateway\'s timestamp is kept', async () => {
    const [row] = await run('2026-03-04T05:06:07Z');
    assert.equal(row!['occurredAt'], '2026-03-04T05:06:07Z');
  });

  it('a timestamp with an offset is stored as the same instant, in UTC', async () => {
    const [row] = await run('2026-03-04T07:06:07+02:00');
    assert.equal(row!['occurredAt'], '2026-03-04T05:06:07Z');
  });

  it('the database keeps whole seconds: a fraction below one half is dropped', async () => {
    const [row] = await run('2026-03-04T05:06:07.400Z');
    assert.equal(row!['occurredAt'], '2026-03-04T05:06:07Z');
  });

  it('the database keeps whole seconds: a fraction of one half or more rounds up', async () => {
    const [row] = await run('2026-03-04T05:06:07.600Z');
    assert.equal(row!['occurredAt'], '2026-03-04T05:06:08Z');
  });

  it('a missing timestamp is the time of the request', async () => {
    const before = Date.now();
    const [row] = await run(undefined);
    const stored = Date.parse(row!['occurredAt'] as string);
    assert.ok(Math.abs(stored - before) < 60_000, `occurredAt ${row!['occurredAt']} should be about now`);
    assert.match(row!['occurredAt'] as string, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  });

  it('a zero timestamp is the time of the request', async () => {
    const before = Date.now();
    for (const zero of ['0001-01-01T00:00:00Z', null]) {
      const [row] = await run(zero);
      assert.ok(Math.abs(Date.parse(row!['occurredAt'] as string) - before) < 60_000);
    }
  });

  it('times are returned as RFC 3339 in UTC, to the second', async () => {
    const [row] = await run('2027-12-31T23:59:59Z');
    assert.equal(row!['occurredAt'], '2027-12-31T23:59:59Z');
  });
});

describe('selecting transactions', () => {
  // One ship with six rows at distinct seconds, so that "newest first" is
  // unambiguous: three purchases, two sales, one ship purchase.
  async function seed(): Promise<string> {
    const ship = uid('Q');
    for (let i = 0; i < 3; i++) {
      await trade('purchase', ship, { symbol: 'IRON_ORE', units: 1 }, p.marketResult(ship, `BUY_${i}`, 'PURCHASE', iso(i * 10), { units: i + 1 }));
    }
    for (let i = 3; i < 5; i++) {
      await trade('sell', ship, { symbol: 'IRON_ORE', units: 1 }, sold(ship, iso(i * 10), { tradeSymbol: `SELL_${i}`, units: i + 1 }));
    }
    gateway.on('POST', '/proxy/my/ships', { json: p.data(p.purchaseShipResult(ship, 'SHIP_PROBE', iso(50))) });
    await call({
      method: 'POST',
      path: `${API}/ships/purchase`,
      headers: { Authorization: bearer(writerToken()) },
      body: JSON.stringify({ shipType: 'SHIP_PROBE', waypointSymbol: 'X1-W' }),
    });
    return ship;
  }

  const stamps = (rows: Row[]) => rows.map((r) => r['occurredAt']);

  it('newest first', async () => {
    const ship = await seed();
    const rows = await history(`shipSymbol=${ship}`);
    assert.deepEqual(stamps(rows), [iso(50), iso(40), iso(30), iso(20), iso(10), iso(0)]);
    assert.deepEqual(rows.map((r) => r['type']), ['SHIP_PURCHASE', 'SELL', 'SELL', 'PURCHASE', 'PURCHASE', 'PURCHASE']);
  });

  it('by type', async () => {
    const ship = await seed();
    assert.deepEqual(stamps(await history(`shipSymbol=${ship}&type=SELL`)), [iso(40), iso(30)]);
    assert.deepEqual(stamps(await history(`shipSymbol=${ship}&type=PURCHASE`)), [iso(20), iso(10), iso(0)]);
    assert.deepEqual(stamps(await history(`shipSymbol=${ship}&type=SHIP_PURCHASE`)), [iso(50)]);
  });

  it('by ship, exactly: a longer symbol that starts the same is another ship', async () => {
    const ship = uid('Q');
    const longer = `${ship}-2`;
    await trade('sell', ship, { symbol: 'X', units: 1 }, sold(ship, iso(0)));
    await trade('sell', longer, { symbol: 'X', units: 1 }, sold(longer, iso(1)));
    assert.deepEqual(stamps(await history(`shipSymbol=${ship}`)), [iso(0)]);
    assert.deepEqual(stamps(await history(`shipSymbol=${longer}`)), [iso(1)]);
    assert.deepEqual(await history(`shipSymbol=${ship.slice(0, -1)}`), []);
  });

  it('the ship filter ignores case and accents, as the database\'s collation does', async () => {
    const ship = `${uid('Q')}-café`;
    await trade('sell', ship, { symbol: 'X', units: 1 }, sold(ship, iso(0)));
    assert.equal((await history(`shipSymbol=${encodeURIComponent(ship.toLowerCase())}`)).length, 1);
    assert.equal((await history(`shipSymbol=${encodeURIComponent(ship.toUpperCase())}`)).length, 1);
    assert.equal((await history(`shipSymbol=${encodeURIComponent(ship.replace('é', 'e'))}`)).length, 1);
    const [row] = await history(`shipSymbol=${encodeURIComponent(ship.toLowerCase())}`);
    assert.equal(row!['shipSymbol'], ship, 'the stored spelling is returned');
  });

  it('by ship and type together', async () => {
    const ship = await seed();
    assert.deepEqual(stamps(await history(`type=SELL&shipSymbol=${ship}`)), [iso(40), iso(30)]);
    assert.deepEqual(await history(`type=SHIP_PURCHASE&shipSymbol=${ship}-nope`), []);
  });

  it('a ship that has no history is an empty list, not null', async () => {
    const res = await call({ path: `${API}/transactions?shipSymbol=${uid('Q')}` });
    expectJson(res, 200, []);
  });

  it('limit keeps the newest rows', async () => {
    const ship = await seed();
    assert.deepEqual(stamps(await history(`shipSymbol=${ship}&limit=1`)), [iso(50)]);
    assert.deepEqual(stamps(await history(`shipSymbol=${ship}&limit=3`)), [iso(50), iso(40), iso(30)]);
    assert.equal((await history(`shipSymbol=${ship}&limit=6`)).length, 6);
    assert.equal((await history(`shipSymbol=${ship}&limit=7`)).length, 6);
    assert.equal((await history(`shipSymbol=${ship}&limit=1000`)).length, 6);
  });

  it('limit is applied after the filters', async () => {
    const ship = await seed();
    assert.deepEqual(stamps(await history(`shipSymbol=${ship}&type=PURCHASE&limit=2`)), [iso(20), iso(10)]);
  });

  it('limit accepts what a decimal integer parser accepts: leading zeros and a plus sign', async () => {
    const ship = await seed();
    assert.equal((await history(`shipSymbol=${ship}&limit=02`)).length, 2);
    assert.equal((await history(`shipSymbol=${ship}&limit=%2B3`)).length, 3);
    assert.equal((await history(`shipSymbol=${ship}&limit=000000000000000000000004`)).length, 4);
  });

  it('empty parameters mean "not given"', async () => {
    const ship = await seed();
    assert.equal((await history(`shipSymbol=${ship}&type=&limit=`)).length, 6);
    assert.ok((await history('shipSymbol=&type=&limit=')).length >= 6, 'an empty shipSymbol is no filter');
  });

  it('the first of a repeated parameter wins', async () => {
    const ship = await seed();
    assert.equal((await history(`shipSymbol=${ship}&limit=2&limit=abc`)).length, 2);
    assert.equal((await history(`shipSymbol=${ship}&type=SELL&type=bogus`)).length, 2);
    assert.equal((await history(`shipSymbol=${ship}&shipSymbol=${uid('Q')}`)).length, 6);
  });

  it('parameter names are case-sensitive and unknown ones are ignored', async () => {
    const ship = await seed();
    assert.equal((await history(`shipSymbol=${ship}&Limit=1&TYPE=SELL&other=1`)).length, 6);
    // shipsymbol is not shipSymbol: no filter. A ship with no rows would give [] if it filtered.
    assert.equal((await history(`shipsymbol=${uid('Q')}&limit=1`)).length, 1);
  });

  it('parameters are percent-decoded; a plus is a space', async () => {
    const ship = await seed();
    assert.equal((await history(`shipSymbol=${ship}&type=%53ELL`)).length, 2);
    const spaced = `${uid('Q')} x`;
    await trade('sell', spaced, { symbol: 'X', units: 1 }, sold(spaced, iso(0)));
    assert.equal((await history(`shipSymbol=${spaced.replace(' ', '+')}`)).length, 1);
  });

  it('a pair that cannot be parsed is dropped as if it were not there', async () => {
    const ship = await seed();
    // A semicolon is no longer a separator, and a pair that has one is dropped;
    // so is one with a malformed percent escape.
    assert.equal((await history(`shipSymbol=${ship}&limit=2;x=1`)).length, 6);
    assert.equal((await history(`shipSymbol=${ship}&type=%zz`)).length, 6);
    assert.equal((await history(`shipSymbol=${ship}&limit=%zz`)).length, 6);
  });
});

describe('rejected query parameters', () => {
  const LIMIT = 'limit must be a positive integer';
  const TYPE = 'type must be one of: SHIP_PURCHASE, PURCHASE, SELL';

  async function get(query: string) {
    return call({ path: `${API}/transactions?${query}` });
  }

  for (const raw of ['0', '-1', '-0', 'abc', '1.5', '1e3', '%205', '5%20', '0x10', '99999999999999999999', '9223372036854775808', '+', '-', '%2B%2B5', '%D9%A1%D9%A2', '1_000', '1,000', 'NaN', 'null']) {
    it(`limit=${raw}: 400`, async () => {
      const res = await get(`limit=${raw}`);
      expectTextStartingWith(res, 400, LIMIT);
      assert.equal(res.text, `${LIMIT}\n`);
    });
  }

  for (const raw of ['purchase', 'Purchase', 'sell', 'FOO', '%20PURCHASE', 'PURCHASE%20', 'SHIP_PURCHASE,SELL', 'PURCHASE%00', 'SHIP-PURCHASE', '0', 'undefined']) {
    it(`type=${raw}: 400`, async () => {
      const res = await get(`type=${raw}`);
      assert.equal(res.status, 400);
      assert.equal(res.text, `${TYPE}\n`);
    });
  }

  it('a bad type is reported before a bad limit', async () => {
    assert.equal((await get('limit=abc&type=nope')).text, `${TYPE}\n`);
    assert.equal((await get('type=nope&limit=abc')).text, `${TYPE}\n`);
  });

  it('a bad limit is reported with a good type', async () => {
    assert.equal((await get('type=SELL&limit=0')).text, `${LIMIT}\n`);
  });

  it('validation comes before the database: a bad query is a 400 for any ship', async () => {
    assert.equal((await get(`shipSymbol=${uid('Q')}&limit=0`)).status, 400);
  });

  it('is not an auth matter: a visitor is told too, and a bad token is told it is a bad token first', async () => {
    assert.equal((await get('limit=0')).status, 400);
    const res = await call({ path: `${API}/transactions?limit=0`, headers: { Authorization: bearer(tokenFor({ kind: 'inactive' })) } });
    expectAuthError(res, 401, MSG.invalidSession);
  });
});

describe('the cap on limit', () => {
  it('limit is capped at 1000, the default is 100, and the newest rows win', async () => {
    const ship = uid('CAP');
    const total = 1001;
    // The row's position is carried in the units, from which the gateway stub
    // derives a distinct second for it.
    gateway.on('POST', `/proxy/my/ships/${ship}/sell`, (req: Recorded) => {
      const n = (JSON.parse(req.body) as { units: number }).units;
      return { json: p.data(sold(ship, iso(n), { units: n })) };
    });
    const post = (n: number) =>
      call({
        method: 'POST',
        path: `${API}/ships/${ship}/sell`,
        headers: { Authorization: bearer(writerToken()) },
        body: JSON.stringify({ symbol: 'X', units: n }),
      });
    for (let start = 1; start <= total; start += 50) {
      const batch = [];
      for (let n = start; n < Math.min(start + 50, total + 1); n++) batch.push(post(n));
      for (const res of await Promise.all(batch)) assert.equal(res.status, 200);
    }

    const units = (rows: Row[]) => rows.map((r) => r['units'] as number);

    const all = await history(`shipSymbol=${ship}&limit=1000`);
    assert.equal(all.length, 1000);
    assert.equal(units(all)[0], 1001);
    assert.equal(units(all)[999], 2);

    for (const limit of ['1001', '1500', '5000', '99999999999', '9223372036854775807']) {
      assert.equal((await history(`shipSymbol=${ship}&limit=${limit}`)).length, 1000, `limit=${limit}`);
    }
    assert.equal((await history(`shipSymbol=${ship}&limit=999`)).length, 999);

    const dflt = await history(`shipSymbol=${ship}`);
    assert.equal(dflt.length, 100);
    assert.equal(units(dflt)[0], 1001);
    assert.equal(units(dflt)[99], 902);
    assert.equal((await history(`shipSymbol=${ship}&limit=1`)).length, 1);
  });
});

describe('an empty answer from the gateway', () => {
  // An empty 2xx is a zero result, not an error, so the history records a zero
  // row: nothing in the answer says otherwise. The row still takes its ship from
  // the path (cargo) and its time from the request.
  for (const [name, status] of [['200', 200], ['204', 204]] as const) {
    for (const action of ['purchase', 'sell'] as const) {
      it(`${action} with an empty ${name} records a zero row for the ship in the path`, async () => {
        const ship = uid('EM');
        gateway.on('POST', `/proxy/my/ships/${ship}/${action}`, { status, raw: '' });
        const before = Date.now();
        const res = await call({
          method: 'POST',
          path: `${API}/ships/${ship}/${action}`,
          headers: { Authorization: bearer(writerToken()) },
          body: '{"symbol":"X","units":1}',
        });
        assert.equal(res.status, 200, res.text);
        const rows = await history(`shipSymbol=${ship}`);
        assert.equal(rows.length, 1);
        const { occurredAt, ...rest } = rows[0]!;
        assert.deepEqual(rest, {
          type: action === 'sell' ? 'SELL' : 'PURCHASE',
          shipSymbol: ship,
          waypointSymbol: '',
          tradeSymbol: '',
          units: 0,
          pricePerUnit: 0,
          totalPrice: 0,
          agentCredits: 0,
        });
        assert.ok(Math.abs(Date.parse(occurredAt as string) - before) < 60_000);
      });
    }

    it(`purchase-ship with an empty ${name} records a zero SHIP_PURCHASE row with no ship symbol`, async () => {
      const blank = async () =>
        (await history('type=SHIP_PURCHASE&limit=1000')).filter((r) => r['shipSymbol'] === '' && r['shipType'] === '').length;
      const before = await blank();
      gateway.on('POST', '/proxy/my/ships', { status, raw: '' });
      const res = await call({
        method: 'POST',
        path: `${API}/ships/purchase`,
        headers: { Authorization: bearer(writerToken()) },
        body: '{"shipType":"A","waypointSymbol":"B"}',
      });
      assert.equal(res.status, 200, res.text);
      assert.equal(await blank(), before + 1);
    });
  }
});

describe('the history is best effort', () => {
  // Each of these makes MySQL refuse the insert. The caller must still get the
  // gateway's answer, whole, and the history must simply lack the row.
  async function refused(
    ship: string,
    upstream: Record<string, Json>,
    check: (rows: Row[]) => void = (rows) => assert.deepEqual(rows, []),
    historyShip = ship,
  ) {
    const res = await trade('sell', ship, { symbol: 'X', units: 1 }, upstream);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(JSON.parse(res.text), upstream);
    check(await history(`shipSymbol=${encodeURIComponent(historyShip)}`));
    // And the service carries on.
    const next = uid('BE');
    await trade('sell', next, { symbol: 'X', units: 1 }, sold(next, iso(0)));
    assert.equal((await history(`shipSymbol=${next}`)).length, 1);
  }

  const tooLong = 'L'.repeat(65);

  it('a ship symbol too long for its column', async () => {
    const ship = `${uid('BE')}-${tooLong}`;
    await refused(ship, sold(ship, iso(0)));
  });

  it('a trade symbol too long for its column', async () => {
    const ship = uid('BE');
    await refused(ship, sold(ship, iso(0), { tradeSymbol: tooLong }));
  });

  it('a waypoint symbol too long for its column', async () => {
    const ship = uid('BE');
    await refused(ship, sold(ship, iso(0), { waypointSymbol: tooLong }));
  });

  it('units beyond 32 bits', async () => {
    const ship = uid('BE');
    await refused(ship, sold(ship, iso(0), { units: 3_000_000_000 }));
  });

  it('a price per unit beyond 32 bits', async () => {
    const ship = uid('BE');
    await refused(ship, sold(ship, iso(0), { pricePerUnit: 3_000_000_000 }));
  });

  it('negative units beyond 32 bits', async () => {
    const ship = uid('BE');
    await refused(ship, sold(ship, iso(0), { units: -3_000_000_000 }));
  });

  it('credits beyond 64 bits are not an int64 at all: the gateway\'s answer is a 502 and nothing is recorded', async () => {
    const ship = uid('BE');
    gateway.on('POST', `/proxy/my/ships/${ship}/sell`, {
      raw: JSON.stringify(p.data(sold(ship, iso(0)))).replace('"credits":175100', '"credits":9223372036854775808'),
    });
    const res = await call({ method: 'POST', path: `${API}/ships/${ship}/sell`, headers: { Authorization: bearer(writerToken()) }, body: '{"symbol":"X","units":1}' });
    assert.equal(res.status, 502);
    assert.deepEqual(await history(`shipSymbol=${ship}`), []);
  });

  it('a time the database cannot hold (after 2038)', async () => {
    const ship = uid('BE');
    await refused(ship, sold(ship, '2040-01-01T00:00:00Z'));
  });

  it('a time the database cannot hold (before 1970)', async () => {
    const ship = uid('BE');
    await refused(ship, sold(ship, '1960-01-01T00:00:00Z'));
  });

  it('a ship purchase with a ship type too long for its column', async () => {
    const ship = uid('BE');
    const upstream = p.purchaseShipResult(ship, tooLong, iso(0));
    gateway.on('POST', '/proxy/my/ships', { json: p.data(upstream) });
    const res = await call({
      method: 'POST',
      path: `${API}/ships/purchase`,
      headers: { Authorization: bearer(writerToken()) },
      body: JSON.stringify({ shipType: 'T', waypointSymbol: 'W' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.text), upstream);
    assert.deepEqual(await history(`shipSymbol=${ship}`), []);
  });

  it('accepting a contract whose id is too long for the table is still a 200', async () => {
    const id = `${uid('BE')}-${tooLong}`;
    gateway.on('POST', `/proxy/my/contracts/${id}/accept`, { json: p.data(p.contractAndAgent(id, true)) });
    const res = await call({ method: 'POST', path: `${API}/contracts/${id}/accept`, headers: { Authorization: bearer(writerToken()) } });
    expectJson(res, 200, p.contractAndAgent(id, true));
  });

  it('accepting and fulfilling the same contract twice is a 200 each time', async () => {
    const id = uid('BE');
    for (const action of ['accept', 'accept', 'fulfill', 'fulfill']) {
      gateway.on('POST', `/proxy/my/contracts/${id}/${action}`, { json: p.data(p.contractAndAgent(id, true)) });
      const res = await call({ method: 'POST', path: `${API}/contracts/${id}/${action}`, headers: { Authorization: bearer(writerToken()) } });
      assert.equal(res.status, 200);
    }
  });
});

describe('contract deliveries', () => {
  const delivery = (contract: string, over: Record<string, Json> = {}) =>
    call({
      method: 'POST',
      path: `${API}/contracts/${contract}/deliveries`,
      headers: { Authorization: bearer(writerToken()) },
      body: JSON.stringify({ shipSymbol: 'SHIP-1', tradeSymbol: 'IRON_ORE', units: 5, ...over }),
    });
  const list = async (contract: string): Promise<Row[]> => {
    const res = await call({ path: `${API}/contracts/${contract}/deliveries` });
    assert.equal(res.status, 200, res.text);
    return JSON.parse(res.text) as Row[];
  };

  it('is recorded and answered with the row', async () => {
    const id = uid('D');
    const before = Date.now();
    const res = await delivery(id);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.headers['content-type'], 'application/json');
    const body = JSON.parse(res.text) as Row;
    assert.deepEqual(Object.keys(body).sort(), ['contractId', 'deliveredAt', 'shipSymbol', 'tradeSymbol', 'units']);
    assert.deepEqual({ ...body, deliveredAt: undefined }, { contractId: id, shipSymbol: 'SHIP-1', tradeSymbol: 'IRON_ORE', units: 5, deliveredAt: undefined });
    // The answer carries the instant as the service read it, to whatever precision
    // the service has, always UTC.
    assert.match(body['deliveredAt'] as string, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,9})?Z$/);
    assert.ok(Math.abs(Date.parse(body['deliveredAt'] as string) - before) < 60_000);
  });

  it('is listed with the same content, the time in whole seconds', async () => {
    const id = uid('D');
    const written = JSON.parse((await delivery(id)).text) as Row;
    const rows = await list(id);
    assert.equal(rows.length, 1);
    assert.deepEqual({ ...rows[0], deliveredAt: undefined }, { ...written, deliveredAt: undefined });
    assert.match(rows[0]!['deliveredAt'] as string, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    const drift = Math.abs(Date.parse(rows[0]!['deliveredAt'] as string) - Date.parse(written['deliveredAt'] as string));
    assert.ok(drift <= 1000, `the stored time is the answered time rounded to the second (${drift} ms apart)`);
  });

  it('is listed oldest first', async () => {
    const id = uid('D');
    await delivery(id, { tradeSymbol: 'FIRST' });
    await sleep(1100);
    await delivery(id, { tradeSymbol: 'SECOND' });
    await sleep(1100);
    await delivery(id, { tradeSymbol: 'THIRD' });
    assert.deepEqual((await list(id)).map((r) => r['tradeSymbol']), ['FIRST', 'SECOND', 'THIRD']);
  });

  it('is kept per contract', async () => {
    const a = uid('D');
    const b = uid('D');
    await delivery(a, { units: 1 });
    await delivery(b, { units: 2 });
    await delivery(b, { units: 3 });
    assert.deepEqual((await list(a)).map((r) => r['units']), [1]);
    assert.deepEqual((await list(b)).map((r) => r['units']).sort(), [2, 3]);
    assert.deepEqual(await list(uid('D')), []);
  });

  it('an unknown contract has an empty list, not null', async () => {
    expectJson(await call({ path: `${API}/contracts/${uid('D')}/deliveries` }), 200, []);
  });

  it('the contract id is matched the way the database matches strings: without regard to case', async () => {
    const id = uid('D');
    await delivery(id);
    assert.equal((await list(id.toLowerCase())).length, 1);
    const [row] = await list(id.toLowerCase());
    assert.equal(row!['contractId'], id);
  });

  it('is readable without a session, and by one without scopes', async () => {
    const id = uid('D');
    await delivery(id);
    assert.equal((await list(id)).length, 1);
    const res = await call({ path: `${API}/contracts/${id}/deliveries`, headers: { Authorization: bearer(readerToken()) } });
    assert.equal(res.status, 200);
  });

  it('the largest 32-bit number of units is accepted, one more is a 500', async () => {
    const id = uid('D');
    assert.equal((await delivery(id, { units: 2147483647 })).status, 200);
    assert.equal((await list(id))[0]!['units'], 2147483647);
    const other = uid('D');
    expectTextStartingWith(await delivery(other, { units: 2147483648 }), 500, 'failed to record delivery: ');
    assert.deepEqual(await list(other), []);
  });

  it('a value too long for its column is a 500 and nothing is recorded', async () => {
    const tooLong = 'L'.repeat(65);
    const a = uid('D');
    expectTextStartingWith(await delivery(a, { shipSymbol: tooLong }), 500, 'failed to record delivery: ');
    expectTextStartingWith(await delivery(a, { tradeSymbol: tooLong }), 500, 'failed to record delivery: ');
    expectTextStartingWith(await delivery(`${uid('D')}-${tooLong}`), 500, 'failed to record delivery: ');
    assert.deepEqual(await list(a), []);
    // 64 is the limit, and it is allowed.
    assert.equal((await delivery(a, { shipSymbol: 'S'.repeat(64) })).status, 200);
  });

  it('characters that are not ASCII round-trip', async () => {
    const id = uid('D');
    assert.equal((await delivery(id, { shipSymbol: 'ÉÜ日本', tradeSymbol: '\u{1F600}' })).status, 200);
    const [row] = await list(id);
    assert.equal(row!['shipSymbol'], 'ÉÜ日本');
    assert.equal(row!['tradeSymbol'], '\u{1F600}');
  });

  it('a contract id with percent-encoded characters is stored decoded', async () => {
    const id = `${uid('D')} a/b`;
    const res = await call({
      method: 'POST',
      path: `${API}/contracts/${encodeURIComponent(id)}/deliveries`,
      headers: { Authorization: bearer(writerToken()) },
      body: '{"shipSymbol":"S","tradeSymbol":"T","units":1}',
    });
    // An encoded slash is a slash by the time the router looks: no route matches.
    assert.equal(res.status, 404);
    const spaced = `${uid('D')} a`;
    assert.equal((await delivery(encodeURIComponent(spaced))).status, 200);
    assert.equal((await list(encodeURIComponent(spaced))).length, 1);
  });
});
