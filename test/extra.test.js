import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/server.js';
import { GAMES, rtp, spin, evaluate } from '../server/games.js';
import { unbalancedTxns, balance } from '../server/wallet.js';

const open = [];
after(() => open.forEach(a => { try { a.server.closeAllConnections(); a.server.close(); } catch {} }));
const start = async opts => { const app = createApp({ simulate: false, signupsPerHour: 1000, ...opts }); await new Promise(r => app.server.listen(0, r)); open.push(app); return { app, base: `http://127.0.0.1:${app.server.address().port}` }; };
const caller = base => { let cookie = ''; return async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return { status: r.status, body: await r.json().catch(() => null) }; }; };
const NEW = { username: 'Tester', password: 'correct horse', dob: '1990-01-01', terms: true, deposit_limit_cents: 0 };

test('data-light: text responses are gzipped on request, images are not, and the content is unchanged', async () => {
  const { base } = await start({ dbPath: ':memory:' });
  // raw bytes on the wire (fetch would hide the compression by decoding it)
  const wire = (path, enc) => new Promise((ok, fail) => http.get(base + path, { headers: { 'Accept-Encoding': enc } }, r => {
    let n = 0; r.on('data', c => (n += c.length)); r.on('end', () => ok({ bytes: n, enc: r.headers['content-encoding'], vary: r.headers.vary }));
  }).on('error', fail));
  for (const path of ['/api/events', '/app.js', '/styles.css', '/']) {
    const gz = await wire(path, 'gzip'), plain = await wire(path, 'identity');
    assert.equal(gz.enc, 'gzip', `${path} compressed`); assert.equal(plain.enc, undefined, `${path} stays plain for clients that do not accept gzip`);
    assert.equal(gz.vary, 'Accept-Encoding');
    assert.ok(gz.bytes < plain.bytes * 0.55, `${path}: ${plain.bytes} -> ${gz.bytes} bytes`);
  }
  const odds = { gz: await wire('/api/events', 'gzip'), plain: await wire('/api/events', 'identity') };
  console.log(`# live odds refresh: ${odds.plain.bytes} -> ${odds.gz.bytes} bytes (${Math.round(100 - 100 * odds.gz.bytes / odds.plain.bytes)}% less); at one refresh per 5s that is ${(odds.plain.bytes * 720 / 1e6).toFixed(1)} -> ${(odds.gz.bytes * 720 / 1e6).toFixed(1)} MB per hour`);
  assert.ok(odds.gz.bytes < odds.plain.bytes / 4, 'live odds shrink by at least 75%');
  assert.equal((await wire('/img/lion.png', 'gzip')).enc, undefined, 'PNG is already compressed');
  assert.equal((await wire('/api/config', 'gzip')).enc, undefined, 'tiny responses are not worth compressing');
  // same content either way
  const a = await (await fetch(base + '/api/games', { headers: { 'Accept-Encoding': 'gzip' } })).json();
  const b = await (await fetch(base + '/api/games', { headers: { 'Accept-Encoding': 'identity' } })).json();
  assert.deepEqual(a, b); assert.equal(a.games.length, 6);
});

test('DEMO_MODE=false disables deposits and simulated settlement', async () => {
  const { app, base } = await start({ dbPath: ':memory:', demoMode: false }); const c = caller(base);
  const me = await c('POST', '/api/register', NEW); assert.equal(me.body.demo, false);
  assert.equal((await c('POST', '/api/deposit', { amount_cents: 10000 })).status, 501);
  assert.equal((await c('POST', '/api/bets/settle-demo', {})).status, 404);
  assert.equal((await c('GET', '/api/me')).body.balance_cents, 0, 'real-money mode never hands out free credit, and nothing changed');
  app.server.close();
});

test('empirical RTP over 300k spins matches the exact RTP for every game', () => {
  for (const g of GAMES) {
    const N = 300_000; let paid = 0;
    for (let i = 0; i < N; i++) paid += evaluate(g, spin(g)).mult;
    const sim = paid / N, exact = rtp(g).rtp;
    // exact per-spin variance by enumeration -> z-score of the simulated mean
    const W = g.weights.reduce((x, y) => x + y, 0); let m2 = 0;
    for (let a = 0; a < 6; a++) for (let b = 0; b < 6; b++) for (let c = 0; c < 6; c++)
      m2 += g.weights[a] * g.weights[b] * g.weights[c] / W ** 3 * evaluate(g, [a, b, c]).mult ** 2;
    const se = Math.sqrt((m2 - exact ** 2) / N), z = (sim - exact) / se;
    console.log(`# ${g.id}: exact ${exact.toFixed(4)} simulated ${sim.toFixed(4)} z=${z.toFixed(2)}`);
    assert.ok(Math.abs(z) < 4.5, `${g.id}: simulated ${sim.toFixed(3)} vs exact ${exact.toFixed(3)} (z=${z.toFixed(2)})`);
  }
});

test('data survives a server restart (file database)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ab-')); const dbPath = join(dir, 't.db');
  let s = await start({ dbPath }); let c = caller(s.base);
  await c('POST', '/api/register', NEW); await c('POST', '/api/games/play', { game: 'bear', stake_cents: 2000 });
  const bal = (await c('GET', '/api/me')).body.balance_cents; s.app.server.close();
  s = await start({ dbPath }); c = caller(s.base);
  assert.equal((await c('POST', '/api/login', { username: 'tester', password: 'correct horse' })).status, 200);
  assert.equal((await c('GET', '/api/me')).body.balance_cents, bal);
  assert.deepEqual(unbalancedTxns(s.app.db), []); s.app.server.close(); rmSync(dir, { recursive: true });
});

test('parallel bets and spins can never overdraw the wallet', async () => {
  const { app, base } = await start({ dbPath: ':memory:' }); const c = caller(base);
  const reg = await c('POST', '/api/register', NEW);
  await Promise.all(Array.from({ length: 40 }, () => c('POST', '/api/games/play', { game: 'shark', stake_cents: 50000 })));
  const uid = reg.body.user.id, b = balance(app.db, `user:${uid}`);
  assert.ok(b >= 0, `balance ${b}`);
  assert.equal((await c('GET', '/api/me')).body.balance_cents, b);
  assert.deepEqual(unbalancedTxns(app.db), []);
  // house + player balances net to zero across the whole ledger
  assert.equal(app.db.prepare('SELECT COALESCE(SUM(amount_cents),0) s FROM ledger_entries').get().s, 0);
  app.server.close();
});

test('input hardening: oversized/invalid bodies, wrong methods, unknown routes', async () => {
  const { app, base } = await start({ dbPath: ':memory:' });
  const post = (p, body, h = { 'Content-Type': 'application/json' }) => fetch(base + p, { method: 'POST', headers: h, body });
  assert.equal((await post('/api/login', '{bad json')).status, 400);
  assert.equal((await post('/api/login', JSON.stringify({ username: 'x'.repeat(30000) }))).status, 413);
  assert.equal((await post('/api/login', '[1,2]')).status, 400);
  assert.equal((await fetch(base + '/api/nope')).status, 404);
  assert.equal((await fetch(base + '/', { method: 'DELETE' })).status, 405);
  const xss = await post('/api/register', JSON.stringify({ ...NEW, username: '<script>alert(1)</script>' }));
  assert.equal(xss.status, 400);
  const sqli = await post('/api/login', JSON.stringify({ username: "' OR 1=1 --", password: 'x' }));
  assert.equal(sqli.status, 401);
  app.server.close();
});

test('sports: settlement win chance keeps the bookmaker margin (deterministic)', async () => {
  const { createOddsEngine, winProbability } = await import('../server/odds.js');
  const engine = createOddsEngine();
  for (const e of engine.snapshot()) for (const m of e.markets) {
    const probs = m.sels.map(x => winProbability(x.odds));
    const total = probs.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(total - 1) < 0.02, `${e.home} v ${e.away} ${m.name}: probabilities sum to ${total}`);       // a real market sums to ~100%
    for (const x of m.sels) assert.ok(Math.abs(winProbability(x.odds) * x.odds - 1 / 1.06) < 1e-9, 'every price returns ~94.3%');
  }
  // the buggy rule (win chance = 1/odds) would give each market a book of ~106% and a 100% return
  const e0 = engine.snapshot()[1].markets[0]; assert.ok(e0.sels.reduce((a, x) => a + 1 / x.odds, 0) > 1.04);
});

test('casino games are demo-only: off in real-money mode unless explicitly enabled', async () => {
  const real = await start({ dbPath: ':memory:', demoMode: false }); let c = caller(real.base);
  let cfg = (await c('GET', '/api/config')).body; assert.equal(cfg.demo, false); assert.equal(cfg.games, false);
  assert.equal((await c('GET', '/api/games')).status, 404);
  await c('POST', '/api/register', NEW);
  assert.equal((await c('POST', '/api/games/play', { game: 'lion', stake_cents: 1000 })).status, 404);
  assert.equal((await c('GET', '/api/me')).body.balance_cents, 0, 'nothing was charged');
  const demo = await start({ dbPath: ':memory:' }); c = caller(demo.base);
  cfg = (await c('GET', '/api/config')).body; assert.equal(cfg.demo, true); assert.equal(cfg.games, true);
  assert.equal((await c('GET', '/api/games')).status, 200);
  const forced = await start({ dbPath: ':memory:', demoMode: false, gamesEnabled: true });   // GAMES_ENABLED=true is a deliberate owner decision
  assert.equal((await caller(forced.base)('GET', '/api/games')).status, 200);
});
