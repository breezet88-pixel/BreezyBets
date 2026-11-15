import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/server.js';
import { unbalancedTxns, balance, post, WalletError } from '../server/wallet.js';
import { ageFromDob } from '../server/auth.js';

let app, base;
before(async () => {
  app = createApp({ dbPath: ':memory:', simulate: false, signupsPerHour: 1000 });
  await new Promise(r => app.server.listen(0, r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => app.server.close());

// Minimal client with a cookie jar.
function client() {
  let cookie = '';
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0].endsWith('=') ? '' : sc.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
  };
}
const reg = (c, username, extra = {}) => c('POST', '/api/register', { username, password: 'correct horse', dob: '1990-01-01', terms: true, ...extra });
const upcoming = async c => (await c('GET', '/api/events')).body.events.filter(e => !e.live && !e.closed);
const sel = (e, i = 0) => ({ ev: e.id, mk: 'w', k: e.markets[0].sels[i].k, odds: e.markets[0].sels[i].odds });

test('ageFromDob', () => {
  assert.equal(ageFromDob('2000-02-30'), null);
  assert.equal(ageFromDob('nope'), null);
  assert.equal(ageFromDob('2000-06-15', new Date('2018-06-14T12:00Z')), 17);
  assert.equal(ageFromDob('2000-06-15', new Date('2018-06-15T12:00Z')), 18);
});

test('registration: validates, rejects under-18, rejects duplicates, grants bonus via ledger', async () => {
  const c = client();
  assert.equal((await reg(c, 'ab')).status, 400);
  assert.equal((await reg(c, 'shorty', { password: 'short' })).status, 400);
  assert.equal((await reg(c, 'kiddo', { dob: new Date(Date.now() - 10 * 365 * 864e5).toISOString().slice(0, 10) })).status, 403);
  assert.equal((await reg(c, 'noterms', { terms: false })).status, 400);
  const ok = await reg(c, 'Thabo');
  assert.equal(ok.status, 201);
  assert.equal(ok.body.balance_cents, 100000);
  assert.match(ok.headers.get('set-cookie'), /HttpOnly/);
  assert.match(ok.headers.get('set-cookie'), /SameSite=Strict/);
  assert.equal((await reg(client(), 'thabo')).status, 409, 'usernames are case-insensitive');
});

test('login / logout / session', async () => {
  const c = client(); await reg(c, 'Lerato');
  assert.equal((await c('GET', '/api/me')).body.user.username, 'Lerato');
  await c('POST', '/api/logout', {});
  assert.equal((await c('GET', '/api/me')).body.user, null);
  const c2 = client();
  assert.equal((await c2('POST', '/api/login', { username: 'lerato', password: 'wrong password' })).status, 401);
  assert.equal((await c2('POST', '/api/login', { username: 'lerato', password: 'correct horse' })).status, 200);
  assert.equal((await c2('GET', '/api/me')).body.user.username, 'Lerato');
});

test('login is rate limited after repeated failures', async () => {
  const c = client(); await reg(c, 'Sipho');
  for (let i = 0; i < 5; i++) await client()('POST', '/api/login', { username: 'sipho', password: 'bad bad bad' });
  assert.equal((await client()('POST', '/api/login', { username: 'sipho', password: 'correct horse' })).status, 429);
});

test('protected routes need a session; JSON content type required', async () => {
  const c = client();
  for (const [m, p] of [['GET', '/api/bets'], ['GET', '/api/ledger'], ['POST', '/api/deposit'], ['POST', '/api/bets']]) assert.equal((await c(m, p, m === 'POST' ? {} : undefined)).status, 401, p);
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(r.status, 415);
});

test('betting: server-side odds, stake deducted via ledger, no overdraft', async () => {
  const c = client(); await reg(c, 'Naledi');
  const [e1, e2] = await upcoming(c);
  // stale/forged odds are rejected, never honoured
  const forged = await c('POST', '/api/bets', { type: 'single', stake_cents: 1000, selections: [{ ...sel(e1), odds: 99 }] });
  assert.equal(forged.status, 409); assert.equal(forged.body.error, 'odds_changed');
  // bad stakes
  assert.equal((await c('POST', '/api/bets', { type: 'single', stake_cents: 100, selections: [sel(e1)] })).status, 400);
  assert.equal((await c('POST', '/api/bets', { type: 'single', stake_cents: 12.5, selections: [sel(e1)] })).status, 400);
  // one selection per match
  assert.equal((await c('POST', '/api/bets', { type: 'multi', stake_cents: 1000, selections: [sel(e1), sel(e1, 1)] })).status, 400);
  // valid multi
  const multi = await c('POST', '/api/bets', { type: 'multi', stake_cents: 2000, selections: [sel(e1), sel(e2)] });
  assert.equal(multi.status, 201); assert.equal(multi.body.balance_cents, 98000);
  // two singles = two bets, two stakes
  const singles = await c('POST', '/api/bets', { type: 'single', stake_cents: 1000, selections: [sel(e1), sel(e2)] });
  assert.equal(singles.body.bet_ids.length, 2); assert.equal(singles.body.balance_cents, 96000);
  // cannot bet more than the balance
  const over = await c('POST', '/api/bets', { type: 'single', stake_cents: 500000, selections: [sel(e1)] });
  assert.equal(over.status, 422); assert.equal(over.body.error, 'insufficient_funds');
  assert.equal((await c('GET', '/api/me')).body.balance_cents, 96000, 'failed bet changed nothing');
  const bets = (await c('GET', '/api/bets')).body.bets;
  assert.equal(bets.length, 3); assert.equal(bets.filter(b => b.status === 'open').length, 3);
});

test('settlement pays winners through the ledger; ledger always balances', async () => {
  const c = client(); await reg(c, 'Zanele');
  const evs = await upcoming(c);
  for (let i = 0; i < 6; i++) await c('POST', '/api/bets', { type: 'single', stake_cents: 1000, selections: [sel(evs[i], 1 % evs[i].markets[0].sels.length)] });
  const before = (await c('GET', '/api/me')).body.balance_cents;
  const r = await c('POST', '/api/bets/settle-demo', {});
  assert.equal(r.body.settled, 6);
  const bets = (await c('GET', '/api/bets')).body.bets;
  const paid = bets.reduce((s, b) => s + b.payout_cents, 0);
  assert.equal(r.body.balance_cents, before + paid);
  assert.equal((await c('POST', '/api/bets/settle-demo', {})).body.settled, 0, 'cannot settle twice');
  assert.deepEqual(unbalancedTxns(app.db), []);
});

test('deposit limits are enforced server-side', async () => {
  const c = client(); await reg(c, 'Mpho');
  assert.equal((await c('PUT', '/api/limits', { deposit_limit_cents: 150000 })).status, 200);
  assert.equal((await c('POST', '/api/deposit', { amount_cents: 100000 })).status, 200);
  const r = await c('POST', '/api/deposit', { amount_cents: 100000 });
  assert.equal(r.status, 422); assert.equal(r.body.error, 'deposit_limit');
  assert.equal((await c('POST', '/api/deposit', { amount_cents: 50000 })).status, 200);
  assert.equal((await c('POST', '/api/deposit', { amount_cents: 1 })).status, 400);
  assert.equal((await c('GET', '/api/me')).body.balance_cents, 100000 + 150000, 'bonus (not counted as deposit) + deposits');
});

test('ledger: unbalanced posts, overdrafts and edits are impossible', () => {
  assert.throws(() => post(app.db, { kind: 'x', entries: [{ account: 'house:a', amount: 100 }, { account: 'house:b', amount: -99 }] }), WalletError);
  assert.throws(() => post(app.db, { kind: 'x', entries: [{ account: 'user:9999', amount: -100 }, { account: 'house:a', amount: 100 }] }), /Insufficient/);
  assert.throws(() => app.db.exec('UPDATE ledger_entries SET amount_cents = 1'), /append-only/);
  assert.throws(() => app.db.exec('DELETE FROM ledger_entries'), /append-only/);
  assert.equal(balance(app.db, 'user:9999'), 0);
});

test('static files served, path traversal blocked', async () => {
  assert.equal((await fetch(base + '/')).status, 200);
  assert.match((await fetch(base + '/')).headers.get('content-security-policy'), /default-src 'self'/);
  assert.notEqual((await fetch(base + '/..%2fpackage.json')).status, 200);
  assert.equal((await fetch(base + '/server/server.js')).status, 404);
});
