// Sharing a bet: what the server contributes. (The share screen itself is covered by the browser suite.)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/server.js';

const open = [];
after(() => open.forEach(a => { try { a.server.closeAllConnections(); a.server.close(); } catch {} }));
const start = async () => {
  const app = createApp({ dbPath: ':memory:', simulate: false, signupsPerHour: 1000 });
  await new Promise(r => app.server.listen(0, r)); open.push(app);
  return `http://127.0.0.1:${app.server.address().port}`;
};
const page = async (base, query = '') => (await fetch(base + '/' + query)).text();
const DEFAULT = 'Simple sports betting for South Africa. Play-money demo. 18+.';

test('a placed bet says which picks it was made of, so it can be shared', async () => {
  const base = await start(); let cookie = '';
  const c = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: r.status, body: await r.json() };
  };
  await c('POST', '/api/register', { username: 'Sharer', password: 'correct horse', dob: '1990-01-01', terms: true, deposit_limit_cents: 0 });
  const [a, b] = (await c('GET', '/api/events')).body.events.filter(e => !e.live);
  const picks = [{ ev: a.id, mk: 'w', k: a.markets[0].sels[0].k }, { ev: b.id, mk: 'w', k: b.markets[0].sels.at(-1).k }];
  const placed = await c('POST', '/api/bets', { type: 'multi', stake_cents: 1000, selections: picks.map((x, i) => ({ ...x, odds: [a, b][i].markets[0].sels.find(s => s.k === x.k).odds })) });
  assert.equal(placed.status, 201);
  const legs = (await c('GET', '/api/bets')).body.bets[0].legs;
  assert.deepEqual(legs.map(l => ({ ev: l.ev, mk: l.mk, k: l.k })), picks);
});

test('a shared-bet link describes itself in the link preview, and nothing from the link is echoed into the page', async () => {
  const base = await start();
  const plain = await page(base);
  assert.ok(plain.includes(`<meta property="og:description" content="${DEFAULT}">`), 'the normal page keeps its normal description');

  const two = await page(base, '?bet=e1-w-h_e5-w-a');
  assert.ok(two.includes('content="2 picks shared with you. Open to add them to your bet slip and choose your own stake. 18+."'));
  assert.ok(!two.includes(DEFAULT));
  assert.ok((await page(base, '?bet=e1-w-h')).includes('content="1 pick shared with you. Open to add it to your bet slip'));
  assert.ok((await page(base, '?bet=' + Array.from({ length: 12 }, (_, i) => `e${i}-w-h`).join('_'))).includes('12 picks shared with you'));

  // anything that is not a well-formed share code leaves the page exactly as it is
  for (const bad of ['?bet=', '?bet=e1-w', '?bet=e1-w-h_', '?bet=' + Array.from({ length: 13 }, (_, i) => `e${i}-w-h`).join('_'),
    '?bet=' + encodeURIComponent('<script>alert(1)</script>'), '?bet=' + encodeURIComponent('e1-w-h"><img src=x onerror=alert(1)>'), '?other=e1-w-h'])
    assert.equal(await page(base, bad), plain, bad);
  assert.equal(await (await fetch(base + '/app.js?bet=e1-w-h')).text(), await (await fetch(base + '/app.js')).text(), 'only the page itself is ever rewritten');
});
