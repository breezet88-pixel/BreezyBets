// Light odds refreshes: ask only for what is on screen, get only what moved, and pay almost nothing when nothing changed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../server/server.js';
import { createOddsEngine } from '../server/odds.js';

const open = [];
after(() => open.forEach(a => { try { a.server.closeAllConnections(); a.server.close(); } catch {} }));
const start = async () => {
  const app = createApp({ dbPath: ':memory:', simulate: false, signupsPerHour: 1000 });
  await new Promise(r => app.server.listen(0, r)); open.push(app);
  return { app, base: `http://127.0.0.1:${app.server.address().port}` };
};
const json = async (base, path) => (await fetch(base + path)).json();
// A raw request, so the test sees exactly what is on the wire (fetch would hide caching and compression).
const raw = (base, path, headers = {}) => new Promise((ok, fail) => http.get(base + path, { headers }, r => {
  const chunks = []; r.on('data', c => chunks.push(c));
  r.on('end', () => ok({ status: r.statusCode, headers: r.headers, body: Buffer.concat(chunks),
    headerBytes: r.rawHeaders.reduce((n, h, i) => n + h.length + (i % 2 ? 2 : 2), 0) + 17 }));
}).on('error', fail));

test('a refresh can ask for only the matches on screen', async () => {
  const { base } = await start();
  const all = await json(base, '/api/events');
  assert.equal(all.events.length, 19); assert.equal(all.live_count, 2);

  const cricket = await json(base, '/api/events?sport=cricket');
  assert.equal(cricket.events.length, 3); assert.ok(cricket.events.every(e => e.sport === 'cricket')); assert.equal(cricket.live_count, 2, 'the Live count comes with every answer');
  const live = await json(base, '/api/events?live=1');
  assert.equal(live.events.length, 2); assert.ok(live.events.every(e => e.live));
  assert.deepEqual((await json(base, '/api/events?ids=e3,e7')).events.map(e => e.id), ['e3', 'e7']);
  const mix = await json(base, '/api/events?sport=cricket&ids=e0');                    // the sport on screen plus a pick from elsewhere on the slip
  assert.deepEqual(mix.events.map(e => e.id).sort(), ['e0', 'e12', 'e13', 'e14']);
  assert.deepEqual(mix.events.find(e => e.id === 'e12'), all.events.find(e => e.id === 'e12'), 'a scoped answer has the same full detail');
  assert.equal((await json(base, '/api/events?sport=curling')).events.length, 0);

  // a malformed id list is ignored rather than trusted
  for (const bad of ['e1;drop', 'e1,', Array.from({ length: 51 }, (_, i) => `e${i}`).join(','), '<script>'])
    assert.equal((await json(base, `/api/events?ids=${encodeURIComponent(bad)}`)).events.length, 19, bad);
});

test('live matches are refreshed with just the numbers that move', async () => {
  const { base } = await start();
  const all = (await json(base, '/api/events')).events, slim = await json(base, '/api/odds?ids=e0,e8,e1');
  assert.deepEqual(Object.keys(slim.odds).sort(), ['e0', 'e1', 'e8']); assert.equal(slim.live_count, 2);
  for (const [id, u] of Object.entries(slim.odds)) {
    const e = all.find(x => x.id === id);
    assert.equal(u.m, e.minute); assert.deepEqual(u.s, e.score); assert.equal(u.c, e.closed ? 1 : 0); assert.equal(u.l, e.live ? 1 : 0);
    assert.deepEqual(u.o, e.markets.map(m => m.sels.map(s => s.odds)), `${id}: prices in market order`);
  }
  assert.deepEqual((await json(base, '/api/odds?ids=e0,zz9')).odds.zz9, undefined, 'an unknown event is simply left out');
  assert.deepEqual((await json(base, '/api/odds')).odds, {});
  assert.deepEqual((await json(base, '/api/odds?ids=' + encodeURIComponent('e0;x'))).odds, {});

  const two = await raw(base, '/api/odds?ids=e0,e8'), full = await raw(base, '/api/events');
  assert.ok(two.body.length < 260, `two live matches: ${two.body.length} bytes`);
  assert.ok(two.body.length < full.body.length / 20, 'a fraction of the full list');
});

test('when nothing has changed, the answer is "not modified" and carries no body', async () => {
  const { app, base } = await start();
  for (const path of ['/api/odds?ids=e12', '/api/events?sport=cricket']) {
    const first = await raw(base, path);
    assert.equal(first.status, 200); assert.match(first.headers.etag, /^W\/"[\w-]{16}"$/); assert.equal(first.headers['cache-control'], 'no-cache');
    const again = await raw(base, path, { 'If-None-Match': first.headers.etag });
    assert.equal(again.status, 304, path); assert.equal(again.body.length, 0); assert.equal(again.headers.etag, first.headers.etag);
    assert.equal((await raw(base, path, { 'If-None-Match': 'W/"somethingelse000"' })).status, 200, 'a stale copy gets the fresh answer');
  }
  // a live match moves on every tick, so its answer is new every time
  const live = await raw(base, '/api/odds?ids=e0'); app.odds.tick();
  const next = await raw(base, '/api/odds?ids=e0', { 'If-None-Match': live.headers.etag });
  assert.equal(next.status, 200); assert.notEqual(next.headers.etag, live.headers.etag);
  assert.equal(JSON.parse(next.body).odds.e0.m, JSON.parse(live.body).odds.e0.m + 1);
});

test('odds answers carry only the headers they need; every other answer keeps its full security headers', async () => {
  const { base } = await start();
  for (const path of ['/api/odds?ids=e0,e8', '/api/events?live=1', '/api/events']) {
    const r = await raw(base, path, { 'Accept-Encoding': 'gzip' });
    assert.equal(r.headers['x-content-type-options'], 'nosniff'); assert.equal(r.headers['content-type'], 'application/json'); assert.equal(r.headers.vary, 'Accept-Encoding');
    for (const dropped of ['content-security-policy', 'x-frame-options', 'referrer-policy']) assert.equal(r.headers[dropped], undefined, `${path} ${dropped}`);
    assert.ok(r.headerBytes < 330, `${path}: ${r.headerBytes} header bytes`);
  }
  assert.equal((await raw(base, '/api/events', { 'Accept-Encoding': 'gzip' })).headers['content-encoding'], 'gzip', 'big answers are still compressed');
  for (const path of ['/', '/api/config', '/api/me', '/api/games', '/api/payout-stats']) {
    const r = await raw(base, path);
    assert.match(r.headers['content-security-policy'], /default-src 'self'/, path); assert.equal(r.headers['x-frame-options'], 'DENY', path);
  }
  assert.equal((await raw(base, '/api/me')).headers['cache-control'], 'no-store', 'anything about an account is never cached');
});

test('sample feed: live prices move on every tick, pre-match prices only now and then, and nothing moves after full time', () => {
  const engine = createOddsEngine(), prices = e => JSON.stringify(e.markets.map(m => m.sels.map(s => s.odds)));
  let before = engine.snapshot(), preMoves = 0, liveClock = 0, ticks = 20;
  for (let i = 0; i < ticks; i++) {
    engine.tick(); const now = engine.snapshot();
    for (const e of now) {
      const was = before.find(x => x.id === e.id);
      if (!e.live && prices(e) !== prices(was)) preMoves++;
      if (e.live && e.minute === was.minute + 1) liveClock++;
    }
    before = now;
  }
  const preMatch = before.filter(e => !e.live).length;
  assert.equal(liveClock, 2 * ticks, 'both live matches advance on every tick');
  assert.ok(preMoves > 0 && preMoves < preMatch * ticks * 0.4, `pre-match prices moved ${preMoves} times in ${preMatch * ticks} chances`);

  for (let i = 0; i < 60; i++) engine.tick();                      // play both live matches to full time
  const done = engine.snapshot().filter(e => e.live); assert.ok(done.every(e => e.closed));
  engine.tick(); engine.tick();
  assert.deepEqual(engine.snapshot().filter(e => e.live), done, 'after full time the clock, score and prices are frozen');
});
