// Browser end-to-end test. Needs Playwright (not a project dependency):  node test/e2e.cjs
// Starts its own server on a temp database, drives the UI, and cross-checks the UI against the API.
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const os = require('node:os'), path = require('node:path'), fs = require('node:fs');
const PORT = 3200 + Math.floor(Math.random() * 500), BASE = `http://localhost:${PORT}`;
const SHOTS = process.env.SHOTS || os.tmpdir();
const OLD = new RegExp(['bre', 'ez'].join(''), 'i');   // the retired product name, assembled so it never appears in the source
const results = []; const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-e2e-'));
  const srv = spawn('node', ['--disable-warning=ExperimentalWarning', path.join(__dirname, '../server/server.js')], { env: { ...process.env, PORT, DB_PATH: path.join(dir, 'e2e.db') }, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 1500));
  const browser = await chromium.launch(); const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } }); const p = await ctx.newPage();
  const problems = []; p.on('pageerror', e => problems.push('pageerror: ' + e.message));
  // Chrome logs every 4xx API reply as a console error; the test provokes some on purpose, so ignore only those.
  p.on('console', m => { const t = m.text(); if (/status of (400|401|403|409|422)/.test(t)) return; if (m.type() === 'error' || /Content Security Policy/i.test(t)) problems.push('console: ' + t); });
  p.on('requestfailed', r => problems.push('requestfailed: ' + r.url()));
  const api = (m, u, b) => p.evaluate(async ([m, u, b]) => { const r = await fetch('/api' + u, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { s: r.status, d: await r.json() }; }, [m, u, b]);
  const bal = async () => (await api('GET', '/me')).d.balance_cents;
  const toast = async re => { await p.waitForFunction(re => new RegExp(re, 'i').test(document.querySelector('#toast').textContent), re.source, { timeout: 8000 }); };
  const clearToast = () => p.evaluate(() => { const t = document.querySelector('#toast'); t.textContent = ''; t.classList.remove('show'); });
  const click = sel => p.click(sel);
  const nav = v => click(`#mainNav [data-view=${v}]`);
  const fillAuth = async (u, pw, dob, terms) => { await p.fill('input[name=username]', u); await p.fill('input[name=password]', pw); if (dob) { await p.fill('input[name=dob]', dob); if (terms) await p.check('input[name=terms]'); } await click('#authForm button'); };

  try {
    /* ---------- load ---------- */
    await p.goto(BASE); await p.waitForSelector('.gcard');
    check('title is ApexBets', /ApexBets/.test(await p.title()) && !OLD.test(await p.title()));
    check('retired product name appears nowhere on the page', !OLD.test(await p.content()));
    check('6 game cards', (await p.locator('.gcard').count()) === 6);
    await p.waitForLoadState('networkidle');
    check('all images load (6 art + logo)', await p.evaluate(() => [...document.images].every(i => i.naturalWidth > 0)));
    check('game art PNGs are transparent', await p.evaluate(async () => { const out = []; for (const id of ['shark','tiger','bear','eagle','wolf','lion']) { const im = new Image(); im.src = `/img/${id}.png`; await im.decode(); const c = document.createElement('canvas'); c.width = c.height = 16; const x = c.getContext('2d'); x.drawImage(im, 0, 0, 16, 16); out.push(x.getImageData(0, 0, 1, 1).data[3] === 0); } return out.every(Boolean); }));
    check('responsible-gambling helpline in footer', /0800 006 008/.test(await p.textContent('footer')));

    /* ---------- not logged in ---------- */
    await click('[data-game=lion]'); await click('#gspin'); await p.waitForSelector('#authForm');
    check('spin while logged out asks to log in', true); await p.keyboard.press('Escape');
    check('Escape closes modal', await p.locator('#modal').isHidden());
    check('API refuses protected routes when logged out', (await api('GET', '/bets')).s === 401 && (await api('POST', '/games/play', { game: 'lion', stake_cents: 500 })).s === 401);

    /* ---------- register validation ---------- */
    await click('#acct [data-act=join]');
    await fillAuth('kid', 'correct horse', new Date(Date.now() - 12 * 365 * 864e5).toISOString().slice(0, 10), true);
    await p.waitForFunction(() => /18/.test(document.querySelector('#authErr').textContent));
    check('under-18 registration rejected in UI', true);
    await p.fill('input[name=dob]', '1990-04-04'); await p.fill('input[name=username]', 'Hunter'); await p.fill('input[name=password]', 'correct horse');
    await click('#authForm button'); await p.waitForSelector('.bal');
    check('registration succeeds, R1 000 demo credit', (await bal()) === 100000 && /1\D?000/.test(await p.textContent('.bal')));
    await click('[data-act=logout]'); await p.waitForSelector('#acct [data-act=login]');
    check('logout', (await api('GET', '/me')).d.user === null);
    await click('#acct [data-act=join]'); await fillAuth('hunter', 'correct horse', '1990-04-04', true);
    await p.waitForFunction(() => /taken/i.test(document.querySelector('#authErr').textContent)); check('duplicate username (case-insensitive) rejected', true);
    await click('#modal [data-act=login]'); await fillAuth('Hunter', 'wrong password');
    await p.waitForFunction(() => /invalid/i.test(document.querySelector('#authErr').textContent)); check('wrong password rejected', true);
    await p.fill('input[name=password]', 'correct horse'); await click('#authForm button'); await p.waitForSelector('.bal');
    check('login works and balance persists', (await bal()) === 100000);
    await p.reload(); await p.waitForSelector('.bal'); check('session survives page reload', (await bal()) === 100000);

    /* ---------- all six games ---------- */
    let ledgerNet = 0;
    for (const id of ['lion', 'tiger', 'bear', 'eagle', 'wolf', 'shark']) {
      await nav('games'); await click(`[data-game=${id}]`); await p.waitForSelector('#gspin');
      check(`${id}: paytable present`, (await p.locator('.pt tr').count()) >= 8);
      const before = await bal(); await click('[data-gstake="5"]'); await click('#gspin');
      await p.waitForFunction(() => !document.querySelector('.reel.spin') && !/Spinning/.test(document.querySelector('#gres').textContent), null, { timeout: 8000 });
      const after = await bal(), msg = await p.textContent('#gres');
      const symbols = await p.$$eval('.reel', r => r.map(x => x.textContent));
      const won = /Win R|returned/i.test(msg);
      check(`${id}: spin result consistent`, symbols.length === 3 && (won ? after >= before : after === before - 500), `"${msg}" ${before}→${after}`);
      ledgerNet += after - before; await p.screenshot({ path: path.join(SHOTS, `game-${id}.png`) }); await click('#modal [data-act=close]');
    }
    check('header balance matches server after games', (await bal()) === 100000 + ledgerNet);
    await nav('games'); await click('[data-game=bear]'); await click('[data-gstake="100"]'); await click('#gspin');
    await p.waitForFunction(() => !/Spinning/.test(document.querySelector('#gres').textContent)); await click('#modal [data-act=close]');

    /* ---------- sports ---------- */
    for (const [sport, min] of [['soccer', 5], ['rugby', 4], ['cricket', 3], ['tennis', 2], ['basketball', 2]]) {
      await click(`#side [data-sport=${sport}]`); await p.waitForSelector('.ev');
      check(`${sport}: events listed with odds`, (await p.locator('.ev').count()) >= min && (await p.locator('.odd b').count()) > 0);
    }
    await nav('live'); await p.waitForSelector('.ev');
    check('Live view shows only live matches', (await p.locator('.ev .live').count()) === (await p.locator('.ev').count()) && (await p.locator('.ev').count()) >= 2);
    const m0 = await p.textContent('.ev .live'); await p.waitForTimeout(5600);
    check('live match clock advances', (await p.textContent('.ev .live')) !== m0, `${m0} → ${await p.textContent('.ev .live')}`);

    await click('#side [data-sport=cricket]'); await p.waitForSelector('.ev');
    const placeBet = async () => { for (let i = 0; i < 4; i++) { await clearToast(); await click('[data-act=place]'); await toast(/placed|changed|insufficient|minimum|maximum/); const t = await p.textContent('#toast'); if (/placed/i.test(t)) return 'ok'; if (!/changed/i.test(t)) return t; await p.waitForTimeout(300); } return 'odds kept changing'; };
    await p.locator('.ev').nth(0).locator('.odd').first().click(); await p.locator('.ev').nth(1).locator('.odd').first().click();
    check('bet slip shows 2 selections', (await p.textContent('#slipCount')) === '2');
    await p.locator('.ev').nth(0).locator('.odd').nth(1).click();
    check('picking another price in same match replaces it (still 2)', (await p.textContent('#slipCount')) === '2');
    const b0 = await bal(); await p.fill('#stake', '1'); await clearToast(); await click('[data-act=place]'); await toast(/minimum/);
    check('stake below minimum rejected', (await bal()) === b0);
    await p.fill('#stake', '20'); const r1 = await placeBet(); check('two singles placed', r1 === 'ok' && (await bal()) === b0 - 4000, `${r1} ${b0}→${await bal()}`);
    await p.locator('.ev').nth(0).locator('.odd').first().click(); await p.locator('.ev').nth(1).locator('.odd').first().click();
    await click('[data-mode=multi]'); check('multiple shows combined odds', /Total odds/.test(await p.textContent('#slip')));
    await p.fill('#stake', '30'); const b1 = await bal(); const r2 = await placeBet(); check('multiple placed (one stake)', r2 === 'ok' && (await bal()) === b1 - 3000, `${r2}`);
    await p.locator('.ev').nth(0).locator('.odd').first().click(); await p.fill('#stake', '5000'); await clearToast();
    const bTooBig = await bal(); await p.fill('#stake', '4999'); const r3 = await placeBet();
    check('bet larger than balance refused', /insufficient/i.test(r3) && (await bal()) === bTooBig, r3); await click('[data-act=clear]');

    await nav('mybets'); await p.waitForSelector('.bet');
    check('My Bets lists all 3 bets as open', (await p.locator('.bet').count()) === 3 && (await p.locator('.tag.won,.tag.lost').count()) === 0);
    const beforeSettle = await bal(); await click('[data-act=settle]'); await toast(/winning|no winners/);
    const bets = (await api('GET', '/bets')).d.bets; const paid = bets.reduce((s, b) => s + b.payout_cents, 0);
    check('simulated settlement pays exactly the winners', (await bal()) === beforeSettle + paid && bets.every(b => b.status !== 'open'), `paid ${paid}`);

    /* ---------- deposits, limits, statement ---------- */
    await nav('games'); await click('[data-act=limits]'); await p.fill('#lim', '1500'); await click('[data-act=saveLimit]'); await toast(/saved/);
    await click('#acct [data-act=deposit]'); const d0 = await bal(); await click('[data-dep="1000"]'); await toast(/added/);
    check('deposit within limit works', (await bal()) === d0 + 100000);
    await click('#acct [data-act=deposit]'); await clearToast(); await click('[data-dep="1000"]'); await toast(/limit/);
    check('deposit over daily limit refused', (await bal()) === d0 + 100000);
    await click('[data-act=close]');
    await click('#side [data-act=statement]'); await p.waitForSelector('.stmt');
    const rows = await p.locator('.stmt tr').count(); const txt = await p.textContent('.stmt');
    check('statement lists bonus, deposit, stakes, game wins/stakes', rows >= 12 && /Welcome bonus/.test(txt) && /Deposit/.test(txt) && /Game stake/.test(txt) && /Bet stake/.test(txt), `${rows} rows`);
    await p.screenshot({ path: path.join(SHOTS, 'statement.png') }); await click('#modal [data-act=close]');
    const led = (await api('GET', '/ledger')).d.entries.reduce((s, e) => s + e.amount_cents, 0);
    check('statement entries sum to the wallet balance', led === (await bal()), `${led}`);

    /* ---------- mobile ---------- */
    await p.setViewportSize({ width: 390, height: 800 }); await p.waitForTimeout(300);
    check('mobile: no horizontal scroll (games)', await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await p.screenshot({ path: path.join(SHOTS, 'mobile-games.png') });
    await click('#side [data-sport=cricket]'); await p.waitForSelector('.ev'); await p.locator('.ev').nth(0).locator('.odd').first().click();
    check('mobile: no horizontal scroll (sports)', await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await click('#slipFab'); check('mobile: bet slip drawer opens', await p.evaluate(() => document.querySelector('#slip').classList.contains('open')));
    await p.waitForTimeout(500); await p.screenshot({ path: path.join(SHOTS, 'mobile-slip.png') }); check('mobile: drawer is actually on screen', await p.evaluate(() => document.querySelector('#slip').getBoundingClientRect().top < innerHeight - 100)); await click('[data-act=closeSlip]');
    await click('#mainNav [data-view=games]'); await click('[data-game=eagle]'); check('mobile: game modal fits', await p.evaluate(() => { const r = document.querySelector('#modalCard').getBoundingClientRect(); return r.width <= innerWidth && r.left >= 0; }));
    await click('#modal [data-act=close]');
  } catch (e) { check('script completed without exception', false, e.message.split('\n')[0]); await p.screenshot({ path: path.join(SHOTS, 'failure.png') }).catch(() => {}); }

  check('no console errors / CSP violations / failed requests', problems.length === 0, problems.slice(0, 3).join(' | '));
  await browser.close(); srv.kill(); fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter(r => !r).length; console.log(`\n${results.length - failed}/${results.length} checks passed`); process.exit(failed ? 1 : 0);
})();
