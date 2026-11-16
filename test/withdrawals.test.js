// Withdrawals: the bank account, the automatic rules, the tracked payout, and what happens when it goes wrong.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/server.js';
import { unbalancedTxns, balance } from '../server/wallet.js';

const open = [];
after(() => open.forEach(a => { try { a.server.closeAllConnections(); a.server.close(); } catch {} }));
// The simulated bank is sped up: sent 20 ms after approval, paid 30 ms after that.
const start = async (opts = {}) => {
  const app = createApp({ dbPath: ':memory:', simulate: false, signupsPerHour: 1000, payoutSendMs: 20, payoutPaidMs: 30, ...opts });
  await new Promise(r => app.server.listen(0, r)); open.push(app);
  return { app, base: `http://127.0.0.1:${app.server.address().port}` };
};
const caller = base => { let cookie = ''; return async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return { status: r.status, body: await r.json().catch(() => null) }; }; };
const person = username => ({ username, password: 'correct horse', dob: '1990-01-01', terms: true, deposit_limit_cents: 0 });
const ACCOUNT = { bank: 'Capitec', account_number: '1234567890', holder: 'Thandi Mokoena' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 4000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out waiting'); await sleep(15); } };
const me = async c => (await c('GET', '/api/me')).body;
const find = async (c, id) => (await c('GET', '/api/withdrawals')).body.withdrawals.find(w => w.id === id);
const finished = (c, id) => until(async () => { const w = await find(c, id); return ['paid', 'failed', 'declined'].includes(w.status) ? w : null; });
// A signed-up player who has bet their R1 000 of play money once (100 rounds of R10), with a bank account saved.
async function readyPlayer(base, name, account = ACCOUNT) {
  const c = caller(base); await c('POST', '/api/register', person(name));
  for (let i = 0; i < 100; i++) await c('POST', '/api/games/play', { game: 'bear', stake_cents: 1000 });
  if (account) assert.equal((await c('PUT', '/api/payout-account', account)).status, 200);
  return c;
}
const sound = app => {                                        // the books always balance
  assert.deepEqual(unbalancedTxns(app.db), []);
  assert.equal(app.db.prepare('SELECT COALESCE(SUM(amount_cents),0) s FROM ledger_entries').get().s, 0);
};

test('bank account: validated, and only the last four digits are ever stored', async () => {
  const { app, base } = await start(); const c = caller(base);
  assert.equal((await c('PUT', '/api/payout-account', ACCOUNT)).status, 401);
  await c('POST', '/api/register', person('Thandi'));
  assert.equal((await me(c)).payout_account, null);
  for (const [field, value, code] of [['bank', 'Bank of Nowhere', 'bad_bank'], ['bank', undefined, 'bad_bank'], ['account_number', '12ab567', 'bad_account'], ['account_number', '12345', 'bad_account'],
    ['account_number', 1234567890, 'bad_account'], ['account_number', '1'.repeat(17), 'bad_account'], ['holder', '', 'bad_holder'], ['holder', '<script>alert(1)</script>', 'bad_holder'], ['holder', 'X', 'bad_holder']]) {
    const r = await c('PUT', '/api/payout-account', { ...ACCOUNT, [field]: value });
    assert.equal(r.status, 400, `${field}=${value}`); assert.equal(r.body.error, code);
  }
  const ok = await c('PUT', '/api/payout-account', ACCOUNT);
  assert.equal(ok.status, 200); assert.deepEqual(ok.body.payout_account, { bank: 'Capitec', last4: '7890', holder: 'Thandi Mokoena' });
  const stored = JSON.stringify(app.db.prepare('SELECT * FROM payout_accounts').all());
  assert.ok(!stored.includes('1234567890') && !stored.includes('123456'), 'the full account number is not in the database');
  const changed = await c('PUT', '/api/payout-account', { bank: 'FNB', account_number: '62000011112', holder: "Thandi O'Neil-Mokoena" });
  assert.deepEqual(changed.body.payout_account, { bank: 'FNB', last4: '1112', holder: "Thandi O'Neil-Mokoena" });
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM payout_accounts').get().n, 1, 'one account per player');
});

test('play-through: money put in must be bet once before it can leave; winnings always can', async () => {
  const { app, base } = await start(); const c = caller(base);
  await c('POST', '/api/register', person('Sipho'));
  let m = await me(c);
  assert.equal(m.unplayed_cents, 100000); assert.equal(m.withdrawable_cents, 0, 'fresh play money cannot be withdrawn');
  const early = await c('POST', '/api/withdrawals', { amount_cents: 5000 });
  assert.equal(early.status, 409); assert.equal(early.body.error, 'no_payout_account', 'a bank account comes first');
  await c('PUT', '/api/payout-account', ACCOUNT);
  const unplayed = await c('POST', '/api/withdrawals', { amount_cents: 5000 });
  assert.equal(unplayed.status, 422); assert.equal(unplayed.body.error, 'not_played'); assert.match(unplayed.body.message, /bet once/);
  for (const bad of [4999, 50.5, '5000', -5000, null]) assert.equal((await c('POST', '/api/withdrawals', { amount_cents: bad })).status, 400, `amount ${bad}`);

  for (let i = 0; i < 100; i++) await c('POST', '/api/games/play', { game: 'bear', stake_cents: 1000 });
  m = await me(c);
  assert.equal(m.unplayed_cents, 0); assert.equal(m.withdrawable_cents, m.balance_cents, 'once it has been bet, the whole balance can be withdrawn');
  assert.ok(m.balance_cents >= 20000, `balance after play ${m.balance_cents}`);

  await c('POST', '/api/deposit', { amount_cents: 20000 });
  m = await me(c);
  assert.equal(m.unplayed_cents, 20000); assert.equal(m.withdrawable_cents, m.balance_cents - 20000, 'a new deposit is held back until it is bet');
  const tooMuch = await c('POST', '/api/withdrawals', { amount_cents: m.withdrawable_cents + 100 });
  assert.equal(tooMuch.status, 422); assert.equal(tooMuch.body.error, 'not_played');
  const overBalance = await c('POST', '/api/withdrawals', { amount_cents: m.balance_cents + 5000 });
  assert.equal(overBalance.status, 422); assert.equal(overBalance.body.error, 'insufficient_funds');
  assert.equal((await me(c)).balance_cents, m.balance_cents, 'refused requests change nothing');
  assert.equal((await c('GET', '/api/withdrawals')).body.withdrawals.length, 0);
  sound(app);
});

test('automatic withdrawal: approved at once, sent, paid; every step is timed and the ledger follows the money', async () => {
  const { app, base } = await start(); const c = await readyPlayer(base, 'Naledi');
  const before = (await me(c)).balance_cents, t0 = Date.now();
  const r = await c('POST', '/api/withdrawals', { amount_cents: 10000 });
  assert.equal(r.status, 201);
  const w = r.body.withdrawal;
  assert.equal(w.status, 'approved'); assert.equal(w.auto, true); assert.equal(w.reason, null);
  assert.equal(w.bank, 'Capitec'); assert.equal(w.last4, '7890');
  assert.ok(w.created_at >= t0 && w.approved_at === w.created_at, 'approved in the same instant it was requested');
  assert.equal(r.body.balance_cents, before - 10000, 'the wallet is debited at once, so the money cannot be bet again');
  assert.equal(balance(app.db, 'house:withdrawals_pending'), 10000);

  const paid = await finished(c, w.id);
  assert.equal(paid.status, 'paid');
  assert.equal(paid.sent_at, paid.approved_at + 20); assert.equal(paid.paid_at, paid.sent_at + 30); assert.equal(paid.closed_at, paid.paid_at);
  assert.equal(balance(app.db, 'house:withdrawals_pending'), 0); assert.equal(balance(app.db, 'house:paid_out'), 10000);
  assert.equal((await me(c)).balance_cents, before - 10000);

  assert.equal((await c('GET', '/api/statement')).body.withdrawn_cents, 10000, 'it shows on the monthly statement');
  const entry = (await c('GET', '/api/ledger')).body.entries.find(e => e.kind === 'withdrawal');
  assert.equal(entry.amount_cents, -10000); assert.equal(entry.ref, `withdrawal:${w.id}`);
  const stats = (await c('GET', '/api/payout-stats')).body;
  assert.equal(stats.count, 1); assert.equal(stats.auto_share, 1); assert.equal(stats.simulated, true); assert.equal(typeof stats.median_seconds, 'number');
  sound(app);
});

test('a large withdrawal waits for a person: approving pays it, declining returns it', async () => {
  const { app, base } = await start({ autoApproveMaxCents: 10000 }); const c = await readyPlayer(base, 'Lerato');
  const before = (await me(c)).balance_cents;
  const big = (await c('POST', '/api/withdrawals', { amount_cents: 15000 })).body;
  assert.equal(big.withdrawal.status, 'review'); assert.equal(big.withdrawal.auto, false); assert.equal(big.withdrawal.approved_at, null);
  assert.match(big.withdrawal.reason, /over R100 are checked by a person/);
  assert.equal(big.balance_cents, before - 15000);
  await sleep(90);
  assert.equal((await find(c, big.withdrawal.id)).status, 'review', 'it does not move on by itself');

  const change = await c('PUT', '/api/payout-account', { ...ACCOUNT, bank: 'FNB' });
  assert.equal(change.status, 409); assert.equal(change.body.error, 'withdrawal_in_progress', 'the bank account is locked while money is on its way');
  const stranger = caller(base); await stranger('POST', '/api/register', person('Stranger'));
  assert.equal((await stranger('POST', '/api/withdrawals/review-demo', { id: big.withdrawal.id, approve: true })).status, 404, 'nobody else can touch it');
  assert.equal((await caller(base)('POST', '/api/withdrawals/review-demo', { id: big.withdrawal.id, approve: true })).status, 401);
  for (const bad of [999, 'x', null]) assert.equal((await c('POST', '/api/withdrawals/review-demo', { id: bad, approve: true })).status, 404, `id ${bad}`);

  assert.equal((await c('POST', '/api/withdrawals/review-demo', { id: big.withdrawal.id, approve: true })).body.withdrawal.status, 'approved');
  const paid = await finished(c, big.withdrawal.id);
  assert.equal(paid.status, 'paid'); assert.equal(paid.auto, false, 'the record shows a person approved it');
  assert.equal((await c('POST', '/api/withdrawals/review-demo', { id: big.withdrawal.id, approve: true })).status, 404, 'a finished withdrawal cannot be reviewed again');

  const second = (await c('POST', '/api/withdrawals', { amount_cents: 12000 })).body.withdrawal;
  const declined = (await c('POST', '/api/withdrawals/review-demo', { id: second.id, approve: false })).body;
  assert.equal(declined.withdrawal.status, 'declined'); assert.match(declined.withdrawal.reason, /back in your balance/);
  assert.equal(declined.balance_cents, before - 15000, 'the declined amount is back in the wallet');
  assert.equal((await c('GET', '/api/statement')).body.withdrawn_cents, 15000, 'the statement counts only what really left');
  assert.equal(balance(app.db, 'house:withdrawals_pending'), 0); assert.equal(balance(app.db, 'house:paid_out'), 15000);
  assert.equal((await c('GET', '/api/payout-stats')).body.auto_share, 0);
  assert.equal((await c('POST', '/api/withdrawals', { amount_cents: 10000 })).body.withdrawal.status, 'approved', 'exactly the automatic amount is still automatic');
  sound(app);
});

test('a payout the bank rejects comes straight back to the wallet', async () => {
  const { app, base } = await start(); const c = await readyPlayer(base, 'Zanele', { ...ACCOUNT, account_number: '4000000000' });
  const before = (await me(c)).balance_cents;
  const w = (await c('POST', '/api/withdrawals', { amount_cents: 7500 })).body.withdrawal;
  const done = await finished(c, w.id);
  assert.equal(done.status, 'failed'); assert.match(done.reason, /bank rejected/); assert.equal(done.paid_at, null); assert.ok(done.sent_at && done.closed_at);
  assert.equal((await me(c)).balance_cents, before, 'every cent is back');
  assert.equal(balance(app.db, 'house:withdrawals_pending'), 0); assert.equal(balance(app.db, 'house:paid_out'), 0);
  const kinds = (await c('GET', '/api/ledger')).body.entries.filter(e => e.ref === `withdrawal:${w.id}`).map(e => `${e.kind}:${e.amount_cents}`).sort();
  assert.deepEqual(kinds, ['withdrawal:-7500', 'withdrawal_returned:7500']);
  assert.equal((await c('GET', '/api/statement')).body.withdrawn_cents, 0);
  assert.equal((await c('GET', '/api/payout-stats')).body.count, 0, 'a failed payout is not counted as paid');
  assert.equal((await c('PUT', '/api/payout-account', ACCOUNT)).status, 200, 'the account can be corrected once nothing is in progress');
  sound(app);
});

test('a player on a break can still take their money out', async () => {
  const { app, base } = await start(); const c = await readyPlayer(base, 'Mpho');
  assert.equal((await c('POST', '/api/break', { hours: 720 })).status, 200);
  assert.equal((await c('POST', '/api/deposit', { amount_cents: 10000 })).status, 403);
  const w = (await c('POST', '/api/withdrawals', { amount_cents: 5000 }));
  assert.equal(w.status, 201); assert.equal((await finished(c, w.body.withdrawal.id)).status, 'paid');
  sound(app);
});

test('many withdrawal requests at once can never take out more than the balance', async () => {
  const { app, base } = await start(); const c = await readyPlayer(base, 'Busi');
  const before = (await me(c)).balance_cents;
  const results = await Promise.all(Array.from({ length: 40 }, () => c('POST', '/api/withdrawals', { amount_cents: 10000 })));
  const accepted = results.filter(r => r.status === 201).length;
  assert.equal(accepted, Math.floor(before / 10000), 'exactly as many as the balance covers');
  assert.ok(results.filter(r => r.status !== 201).every(r => r.status === 422));
  const after = (await me(c)).balance_cents;
  assert.equal(after, before - accepted * 10000); assert.ok(after >= 0 && after < 10000);
  await until(async () => (await c('GET', '/api/withdrawals')).body.withdrawals.every(w => w.status === 'paid'));
  assert.equal(balance(app.db, 'house:paid_out'), accepted * 10000); assert.equal(balance(app.db, 'house:withdrawals_pending'), 0);
  sound(app);
});

test('real-money mode: withdrawals wait for a payment provider instead of pretending', async () => {
  const { base } = await start({ demoMode: false }); const c = caller(base);
  await c('POST', '/api/register', person('Kagiso'));
  for (const [method, path, body] of [['PUT', '/api/payout-account', ACCOUNT], ['POST', '/api/withdrawals', { amount_cents: 5000 }]]) {
    const r = await c(method, path, body); assert.equal(r.status, 501, path); assert.equal(r.body.error, 'no_payment_provider');
  }
  assert.equal((await c('POST', '/api/withdrawals/review-demo', { id: 1, approve: true })).status, 404);
  assert.deepEqual((await c('GET', '/api/withdrawals')).body.withdrawals, []);
  assert.deepEqual((await c('GET', '/api/payout-stats')).body, { count: 0, simulated: false });
  assert.equal((await c('GET', '/api/withdrawals')).status, 200); assert.equal((await caller(base)('GET', '/api/withdrawals')).status, 401);
});
