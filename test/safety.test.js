// Player protection: the limit chosen at sign-up, the cooling-off period, breaks, and the monthly statement.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/server.js';
import { isLooser, currentMonth } from '../server/safety.js';
import { unbalancedTxns } from '../server/wallet.js';

const open = [];
after(() => open.forEach(a => { try { a.server.closeAllConnections(); a.server.close(); } catch {} }));
const start = async (opts = {}) => {
  const app = createApp({ dbPath: ':memory:', simulate: false, signupsPerHour: 1000, ...opts });
  await new Promise(r => app.server.listen(0, r)); open.push(app);
  return { app, base: `http://127.0.0.1:${app.server.address().port}` };
};
const caller = base => { let cookie = ''; return async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return { status: r.status, body: await r.json().catch(() => null) }; }; };
const person = (username, extra = {}) => ({ username, password: 'correct horse', dob: '1990-01-01', terms: true, deposit_limit_cents: 50000, ...extra });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const HOUR = 36e5;

test('sign-up: a daily deposit limit must be chosen, and the choice is enforced from the first deposit', async () => {
  const { base } = await start(); const c = caller(base);
  const none = person('Nolimit'); delete none.deposit_limit_cents;
  const missing = await c('POST', '/api/register', none);
  assert.equal(missing.status, 400); assert.equal(missing.body.error, 'limit_required');
  for (const bad of [-1, 2.5, '500', null, 500 /* R5 is below the R10 minimum deposit */, 100000001])
    assert.equal((await c('POST', '/api/register', person('Badlimit', { deposit_limit_cents: bad }))).status, 400, `limit ${bad}`);

  const free = await caller(base)('POST', '/api/register', person('Freebird', { deposit_limit_cents: 0 }));
  assert.equal(free.status, 201); assert.equal(free.body.deposit_limit_cents, 0, '"no limit" is allowed, but only as an explicit choice');

  const ok = await c('POST', '/api/register', person('Careful'));
  assert.equal(ok.status, 201); assert.equal(ok.body.deposit_limit_cents, 50000);
  assert.equal(ok.body.pending_limit, null); assert.equal(ok.body.break_until, null);
  assert.equal((await c('POST', '/api/deposit', { amount_cents: 40000 })).status, 200);
  const over = await c('POST', '/api/deposit', { amount_cents: 20000 });
  assert.equal(over.status, 422); assert.equal(over.body.error, 'deposit_limit');
  assert.equal((await c('GET', '/api/me')).body.deposited_today_cents, 40000);
});

test('limits: lowering is instant, raising waits out the cooling-off period, and a pending increase can be cancelled', async () => {
  assert.equal(isLooser(80000, 50000), true); assert.equal(isLooser(0, 50000), true, 'removing a limit is the loosest change');
  assert.equal(isLooser(20000, 50000), false); assert.equal(isLooser(50000, 50000), false);
  assert.equal(isLooser(50000, 0), false, 'adding a limit where there was none is always stricter');

  const { base } = await start({ limitCoolOffMs: 150 }); const c = caller(base);
  await c('POST', '/api/register', person('Thandi'));

  const lower = await c('PUT', '/api/limits', { deposit_limit_cents: 20000 });
  assert.equal(lower.body.deposit_limit_cents, 20000, 'lowering applies at once'); assert.equal(lower.body.pending_limit, null);

  const t0 = Date.now(), raise = await c('PUT', '/api/limits', { deposit_limit_cents: 80000 });
  assert.equal(raise.status, 200); assert.equal(raise.body.deposit_limit_cents, 20000, 'the old limit still applies');
  assert.equal(raise.body.pending_limit.cents, 80000);
  assert.ok(raise.body.pending_limit.at >= t0 + 150 && raise.body.pending_limit.at <= Date.now() + 150);
  assert.equal((await c('POST', '/api/deposit', { amount_cents: 30000 })).status, 422, 'cannot deposit against the pending limit');

  const cancel = await c('PUT', '/api/limits', { deposit_limit_cents: 20000 });
  assert.equal(cancel.body.pending_limit, null, 'saving the current limit cancels the increase');
  await sleep(200);
  assert.equal((await c('GET', '/api/me')).body.deposit_limit_cents, 20000, 'a cancelled increase never takes effect');

  const remove = await c('PUT', '/api/limits', { deposit_limit_cents: 0 });
  assert.equal(remove.body.deposit_limit_cents, 20000); assert.equal(remove.body.pending_limit.cents, 0);
  await sleep(200);
  const after = (await c('GET', '/api/me')).body;
  assert.equal(after.deposit_limit_cents, 0, 'the increase takes effect once the cooling-off period has passed'); assert.equal(after.pending_limit, null);
  assert.equal((await c('POST', '/api/deposit', { amount_cents: 30000 })).status, 200);

  const add = await c('PUT', '/api/limits', { deposit_limit_cents: 10000 });
  assert.equal(add.body.deposit_limit_cents, 10000, 'adding a limit is instant'); assert.equal(add.body.pending_limit, null);
  for (const bad of [500, -1, 2.5, '20000', undefined]) assert.equal((await c('PUT', '/api/limits', { deposit_limit_cents: bad })).status, 400, `limit ${bad}`);
  assert.equal((await caller(base)('PUT', '/api/limits', { deposit_limit_cents: 10000 })).status, 401);
});

test('break: pauses deposits, bets and games, cannot be shortened, and ends on its own', async () => {
  const { app, base } = await start(); const c = caller(base);
  const me = (await c('POST', '/api/register', person('Sipho', { deposit_limit_cents: 0 }))).body;
  const ev = (await c('GET', '/api/events')).body.events.find(e => !e.live);
  const bet = () => ({ type: 'single', stake_cents: 1000, selections: [{ ev: ev.id, mk: 'w', k: ev.markets[0].sels[0].k, odds: ev.markets[0].sels[0].odds }] });

  assert.equal((await caller(base)('POST', '/api/break', { hours: 24 })).status, 401);
  for (const bad of [12, 0, -24, '24', 100000]) assert.equal((await c('POST', '/api/break', { hours: bad })).status, 400, `hours ${bad}`);

  const t0 = Date.now(), b = await c('POST', '/api/break', { hours: 24 });
  assert.equal(b.status, 200);
  assert.ok(b.body.break_until >= t0 + 24 * HOUR && b.body.break_until <= Date.now() + 24 * HOUR);

  for (const [path, body] of [['/api/deposit', { amount_cents: 10000 }], ['/api/bets', bet()], ['/api/games/play', { game: 'lion', stake_cents: 1000 }]]) {
    const r = await c('POST', path, body);
    assert.equal(r.status, 403, path); assert.equal(r.body.error, 'on_break');
  }
  assert.equal((await c('GET', '/api/me')).body.balance_cents, me.balance_cents, 'nothing was charged during the break');

  // still allowed: looking at your account and tightening a limit
  assert.equal((await c('GET', '/api/bets')).status, 200);
  assert.equal((await c('GET', '/api/statement')).status, 200);
  assert.equal((await c('PUT', '/api/limits', { deposit_limit_cents: 10000 })).body.deposit_limit_cents, 10000);

  const week = (await c('POST', '/api/break', { hours: 168 })).body.break_until;
  assert.ok(week >= t0 + 168 * HOUR, 'a break can be extended');
  assert.equal((await c('POST', '/api/break', { hours: 24 })).body.break_until, week, 'a shorter break never shortens a longer one');

  app.db.prepare('UPDATE users SET break_until=? WHERE id=?').run(Date.now() - 1000, me.user.id);   // time passes
  assert.equal((await c('GET', '/api/me')).body.break_until, null);
  assert.equal((await c('POST', '/api/bets', bet())).status, 201, 'betting resumes when the break is over');
});

test('monthly statement: money in, money out and the result all add up from the ledger', async () => {
  const { app, base } = await start(); const c = caller(base);
  await c('POST', '/api/register', person('Zinhle', { deposit_limit_cents: 0 }));
  await c('POST', '/api/deposit', { amount_cents: 20000 });
  const evs = (await c('GET', '/api/events')).body.events.filter(e => !e.live).slice(0, 2);
  const placed = await c('POST', '/api/bets', { type: 'single', stake_cents: 5000, selections: evs.map(e => ({ ev: e.id, mk: 'w', k: e.markets[0].sels[0].k, odds: e.markets[0].sels[0].odds })) });
  assert.equal(placed.status, 201);
  await c('POST', '/api/bets/settle-demo', {});
  let returned = (await c('GET', '/api/bets')).body.bets.reduce((s, b) => s + b.payout_cents, 0);
  for (let i = 0; i < 3; i++) returned += (await c('POST', '/api/games/play', { game: 'bear', stake_cents: 1000 })).body.payout_cents;

  const st = (await c('GET', '/api/statement')).body, bal = (await c('GET', '/api/me')).body.balance_cents;
  assert.equal(st.month, currentMonth()); assert.ok(st.months.includes(currentMonth()));
  assert.equal(st.deposited_cents, 20000); assert.equal(st.bonus_cents, 100000); assert.equal(st.withdrawn_cents, 0);
  assert.equal(st.bets, 2); assert.equal(st.game_rounds, 3);
  assert.equal(st.staked_cents, 2 * 5000 + 3 * 1000);
  assert.equal(st.returned_cents, returned);
  assert.equal(st.result_cents, returned - 13000, 'result = what came back minus what was staked');
  assert.equal(bal, st.bonus_cents + st.deposited_cents - st.withdrawn_cents + st.result_cents, 'the statement explains the whole balance');

  const empty = (await c('GET', '/api/statement?month=2020-01')).body;
  assert.equal(empty.month, '2020-01');
  for (const k of ['deposited_cents', 'bonus_cents', 'withdrawn_cents', 'staked_cents', 'returned_cents', 'result_cents', 'bets', 'game_rounds']) assert.equal(empty[k], 0, k);
  for (const bad of ['2026-13', '2026-1', 'abc', '2026-11-01']) assert.equal((await c('GET', `/api/statement?month=${bad}`)).status, 400, bad);
  assert.equal((await caller(base)('GET', '/api/statement')).status, 401);
  assert.deepEqual(unbalancedTxns(app.db), []);
});

test('a database made by an older version is upgraded in place and keeps its data', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ab-old-')), dbPath = join(dir, 'old.db');
  const old = new DatabaseSync(dbPath);
  old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, pass_hash TEXT NOT NULL, dob TEXT NOT NULL,
    deposit_limit_cents INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    INSERT INTO users (username, pass_hash, dob, deposit_limit_cents, created_at) VALUES ('Oldtimer', 'x', '1980-01-01', 30000, 1);`);
  old.close();

  const { app, base } = await start({ dbPath });
  const cols = app.db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  for (const col of ['deposit_limit_pending_cents', 'deposit_limit_pending_at', 'break_until']) assert.ok(cols.includes(col), col);
  const row = app.db.prepare("SELECT * FROM users WHERE username='Oldtimer'").get();
  assert.equal(row.deposit_limit_cents, 30000); assert.equal(row.break_until, null);
  assert.equal((await caller(base)('POST', '/api/register', person('Newcomer'))).status, 201, 'the upgraded database works for new sign-ups');
  app.server.closeAllConnections(); app.server.close(); rmSync(dir, { recursive: true, force: true });
});
