import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/server.js';
import { unbalancedTxns } from '../server/wallet.js';
import { GAMES, rtp, evaluate } from '../server/games.js';

test('six animal games exist with sane, exactly-computed RTP and capped top prizes', () => {
  assert.deepEqual(GAMES.map(g => g.id).sort(), ['bear', 'eagle', 'lion', 'shark', 'tiger', 'wolf']);
  for (const g of GAMES) {
    const { rtp: r, hitRate } = rtp(g);
    assert.ok(r > 0.93 && r < 0.97, `${g.id} RTP ${r}`);
    assert.ok(hitRate > 0.25 && hitRate < 0.6, `${g.id} hit rate ${hitRate}`);
    assert.ok(Math.max(...g.pay3) <= 1000, `${g.id} top prize`);
  }
});

test('evaluate rules', () => {
  const g = GAMES.find(x => x.id === 'lion');
  assert.deepEqual(evaluate(g, [0, 0, 0]), { mult: 136, win: 'three' });
  assert.equal(evaluate(g, [2, 2, 5]).win, 'pair');
  assert.equal(evaluate(g, [3, 0, 5]).win, 'animal');
  assert.equal(evaluate(g, [1, 2, 3]).mult, 0);
});

let app, base;
before(async () => { app = createApp({ dbPath: ':memory:', simulate: false, signupsPerHour: 1000 }); await new Promise(r => app.server.listen(0, r)); base = `http://127.0.0.1:${app.server.address().port}`; });
after(() => app.server.close());

test('playing: auth required, validation, wallet math, ledger balanced', async () => {
  const call = async (method, path, body, cookie) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json(), cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
  };
  const list = await call('GET', '/api/games'); assert.equal(list.body.games.length, 6);
  assert.ok(list.body.games.every(g => g.image.startsWith('/img/') && g.rtp > 93));
  assert.equal((await call('POST', '/api/games/play', { game: 'lion', stake_cents: 1000 })).status, 401);
  const reg = await call('POST', '/api/register', { username: 'Hunter', password: 'correct horse', dob: '1985-03-03', terms: true, deposit_limit_cents: 0 });
  const ck = reg.cookie;
  assert.equal((await call('POST', '/api/games/play', { game: 'dragon', stake_cents: 1000 }, ck)).status, 400);
  assert.equal((await call('POST', '/api/games/play', { game: 'lion', stake_cents: 50 }, ck)).status, 400);
  assert.equal((await call('POST', '/api/games/play', { game: 'lion', stake_cents: 99999 }, ck)).status, 400);
  let bal = 100000, wins = 0;
  for (const g of GAMES) for (let i = 0; i < 10; i++) {
    const r = await call('POST', '/api/games/play', { game: g.id, stake_cents: 1000 }, ck);
    assert.equal(r.status, 200);
    assert.equal(r.body.reels.length, 3);
    assert.equal(r.body.payout_cents, Math.floor(1000 * r.body.mult));
    bal += r.body.payout_cents - 1000; if (r.body.payout_cents) wins++;
    assert.equal(r.body.balance_cents, bal);
  }
  assert.ok(wins > 0);
  // cannot play with an empty wallet
  let broke; for (let i = 0; i < 200 && !broke; i++) { const r = await call('POST', '/api/games/play', { game: 'shark', stake_cents: 50000 }, ck); if (r.status === 422) broke = r; }
  assert.equal(broke?.body.error, 'insufficient_funds');
  assert.deepEqual(unbalancedTxns(app.db), []);
});
