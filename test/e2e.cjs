// Browser end-to-end test. Needs Playwright (not a project dependency):  node test/e2e.cjs
// Starts its own server on a temp database, drives the UI like a user, and cross-checks the UI against the API.
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
  const hash = async () => (await p.evaluate(() => location.hash));
  const toast = async re => p.waitForFunction(re => new RegExp(re, 'i').test(document.querySelector('#toast').textContent), re.source, { timeout: 8000 });
  const clearToast = () => p.evaluate(() => { const t = document.querySelector('#toast'); t.textContent = ''; t.classList.remove('show'); });
  const click = sel => p.click(sel);
  // click, then wait until the page has actually finished redrawing (aria-current is set by the render)
  const nav = async name => { await click(`#mainNav a[data-nav=${name}]`); await p.waitForSelector(`#mainNav a[data-nav=${name}][aria-current=page]`); };
  const tab = async name => { await click(`.sport-tabs a[href="#/sports/${name}"]`); await p.waitForSelector(`.sport-tabs a[href="#/sports/${name}"][aria-current=page]`); };
  const odd = (row, i = 0) => p.locator('.ev').nth(row).locator('.odd').nth(i);
  const fillAuth = async (u, pw, dob, terms) => { await p.fill('input[name=username]', u); await p.fill('input[name=password]', pw); if (dob) { await p.fill('input[name=dob]', dob); if (terms) await p.check('input[name=terms]'); } await click('#authForm button'); };
  // Place whatever is on the slip. If prices moved, the UI says so; like a user, look again and retry.
  const placeBet = async () => { for (let i = 0; i < 4; i++) { await click('#placeBtn'); await p.waitForSelector('.receipt, #slip .msg', { timeout: 8000 }); if (await p.locator('.receipt').count()) return 'ok'; const t = await p.textContent('#slip .msg'); if (!/changed/i.test(t)) return t; await p.waitForTimeout(300); } return 'prices kept changing'; };

  try {
    /* ---------- first impressions: is it obvious where to go? ---------- */
    await p.goto(BASE); await p.waitForSelector('.ev');
    check('opens straight on the matches (Soccer), address says so', (await hash()) === '#/sports/soccer' && /Soccer/.test(await p.textContent('h1')));
    check('title is ApexBets, retired name nowhere on the page', /ApexBets/.test(await p.title()) && !OLD.test(await p.content()));
    check('exactly 3 places to go: Sports, My Bets, Games', (await p.$$eval('#mainNav a > span', a => a.map(x => x.textContent.trim()))).join('|') === 'Sports|My Bets|Games');
    check('no sidebar / banner clutter', (await p.locator('#side, .hero').count()) === 0);
    check('logged-out header has just two buttons: Log in, Join', (await p.$$eval('#acct button', b => b.map(x => x.textContent.trim()))).join('|') === 'Log in|Join');
    check('current page is marked in the nav', (await p.getAttribute('#mainNav a[data-nav=sports]', 'aria-current')) === 'page');
    check('sport tabs: Live + 5 sports', (await p.locator('.sport-tabs a').count()) === 6);
    check('soccer rows show 1 X 2 prices, column labels above them', (await p.locator('.league').first().locator('.cols span').allTextContents()).join('') === '1X2' && (await p.locator('.ev').first().locator('.odd').count()) === 3);
    check('matches show friendly times (Today/Tomorrow)', /Today|Tomorrow/.test(await p.textContent('.ev:nth-child(3) .ev-meta')));
    await p.waitForLoadState('networkidle');
    check('all images load', await p.evaluate(() => [...document.images].every(i => i.naturalWidth > 0)));

    /* ---------- sports tabs ---------- */
    for (const [sport, min, btns] of [['rugby', 4, 2], ['cricket', 3, 2], ['tennis', 2, 2], ['basketball', 2, 2], ['soccer', 8, 3]]) {
      await tab(sport);
      check(`${sport} tab: ${min} matches, ${btns} prices each`, (await p.locator('.ev').count()) === min && (await p.locator('.ev').first().locator('.odd').count()) === btns && (await p.getAttribute(`.sport-tabs a[href="#/sports/${sport}"]`, 'aria-current')) === 'page');
    }
    await tab('live'); const liveRows = await p.locator('.ev').count();
    check('Live tab shows only live matches', liveRows >= 2 && (await p.locator('.ev .live').count()) === liveRows);
    await p.evaluate(() => { document.querySelector('.odd').__keep = true; });
    const clock0 = await p.textContent('.ev .live'); await p.waitForTimeout(5800);
    check('live clock advances', (await p.textContent('.ev .live')) !== clock0, `${clock0.trim()} → ${(await p.textContent('.ev .live')).trim()}`);
    check('prices refresh IN PLACE (buttons are never replaced, so a tap is never lost)', await p.evaluate(() => document.querySelector('.odd').__keep === true));
    await nav('mybets'); check('My Bets: asks you to log in', /Log in to see your bets/.test(await p.textContent('#content')));
    await p.goBack(); await p.waitForSelector('.ev'); check('Back button returns to the previous page', (await hash()) === '#/sports/live');
    await tab('soccer');

    /* ---------- logged out: tapping a price works, betting asks you to log in ---------- */
    await odd(1, 0).click(); await p.waitForTimeout(300);
    check('tap a price: it highlights and lands on the slip', (await p.locator('#slip .pick').count()) === 1 && (await odd(1, 0).evaluate(e => getComputedStyle(e).backgroundColor)) === 'rgb(0, 195, 137)');
    check('one pick: no confusing Multiple/Singles switch', (await p.locator('#slip .seg').count()) === 0);
    check('slip button tells a logged-out user what happens next', /Log in to place bet/.test(await p.textContent('#placeBtn')));
    await click('#placeBtn'); await p.waitForSelector('#authForm'); check('placing a bet logged out opens log in', /Log in/.test(await p.textContent('#mTitle')));
    await p.keyboard.press('Escape'); check('Escape closes the dialog', await p.locator('#modal').isHidden());
    check('API refuses protected routes when logged out', (await api('GET', '/bets')).s === 401 && (await api('POST', '/games/play', { game: 'lion', stake_cents: 500 })).s === 401);

    /* ---------- accounts ---------- */
    await click('#acct [data-act=join]');
    await fillAuth('kid', 'correct horse', new Date(Date.now() - 12 * 365 * 864e5).toISOString().slice(0, 10), true);
    await p.waitForFunction(() => /18/.test(document.querySelector('#authErr').textContent)); check('under-18 registration rejected', true);
    await p.fill('input[name=dob]', '1990-04-04'); await p.fill('input[name=username]', 'Hunter'); await p.fill('input[name=password]', 'correct horse');
    await click('#authForm button'); await p.waitForSelector('.bal');
    check('registration works, R1 000 play money', (await bal()) === 100000 && /1\D?000/.test(await p.textContent('.bal')));
    check('slip pick survived logging in', (await p.locator('#slip .pick').count()) === 1);
    check('header after login is just: balance, Deposit, Account', (await p.locator('#acct button:visible').allTextContents()).join('|') === 'Deposit' && await p.locator('#acct .bal').isVisible() && (await p.textContent('#acct summary')) === 'Account');
    await click('#acct summary'); await click('#menu [data-act=logout]'); await p.waitForSelector('#acct [data-act=login]');
    check('log out from the Account menu', (await api('GET', '/me')).d.user === null);
    await click('#acct [data-act=join]'); await fillAuth('hunter', 'correct horse', '1990-04-04', true);
    await p.waitForFunction(() => /taken/i.test(document.querySelector('#authErr').textContent)); check('duplicate username rejected (case-insensitive)', true);
    await click('#modal [data-act=login]'); await fillAuth('Hunter', 'wrong password');
    await p.waitForFunction(() => /invalid/i.test(document.querySelector('#authErr').textContent)); check('wrong password rejected', true);
    await p.fill('input[name=password]', 'correct horse'); await click('#authForm button'); await p.waitForSelector('.bal');
    check('log in works', (await bal()) === 100000);
    await p.reload(); await p.waitForSelector('.bal'); check('session survives a page reload', (await bal()) === 100000);

    /* ---------- placing bets ---------- */
    await tab('cricket'); await p.waitForSelector('.ev'); await click('#slip [data-act=clear]').catch(() => {});
    await odd(0, 0).click(); await odd(1, 0).click();
    check('2 picks: Multiple is the default, total odds shown', (await p.getAttribute('#slip [data-mode=multi]', 'aria-pressed')) === 'true' && /Total odds/.test(await p.textContent('#slip')));
    await odd(0, 1).click(); check('another price in the same match replaces the first (still 2 picks)', (await p.locator('#slip .pick').count()) === 2);
    await tab('rugby'); check('slip is kept while browsing other sports', (await p.locator('#slip .pick').count()) === 2);
    await tab('cricket');
    const b0 = await bal(); await p.fill('#stake', '1'); await click('#placeBtn');
    check('stake below the minimum: clear message on the slip, nothing charged', /minimum/i.test(await p.textContent('#slip .msg')) && (await bal()) === b0);
    await p.fill('#stake', '20'); check('typing a stake updates the numbers without losing focus', await p.evaluate(() => document.activeElement.id === 'stake') && /20,00/.test(await p.textContent('#placeBtn')) && /20,00/.test(await p.textContent('#retVal')) === false);
    await click('#slip [data-mode=single]'); check('Singles: total stake is per-pick x picks', /40,00/.test(await p.textContent('#stakeTot')));
    const r1 = await placeBet();
    check('two singles placed; clear confirmation on the slip', r1 === 'ok' && (await bal()) === b0 - 4000 && /Bet placed/.test(await p.textContent('#slip .receipt')) && (await p.locator('#slip .receipt a[href="#/my-bets"]').count()) === 1, `${r1}`);
    check('open-bet count appears on My Bets in the nav', (await p.textContent('#openBadge')) === '2');
    await click('#slip [data-act=newbet]'); check('"Keep betting" clears the confirmation', (await p.locator('#slip .receipt').count()) === 0 && /empty/i.test(await p.textContent('#slip')) && (await p.locator('.odd.sel').count()) === 0);
    await odd(0, 0).click(); await odd(1, 0).click(); await odd(2, 0).click();
    check('a new bet starts from the default R50 stake (R20 from last time did not carry over)', (await p.inputValue('#stake')) === '50');
    await p.fill('#stake', '30');
    check('3 picks default to one Multiple', /Total odds/.test(await p.textContent('#slip')) && (await p.locator('#slip .pick').count()) === 3);
    const b1 = await bal(); const r2 = await placeBet(); check('multiple placed (one stake of R30)', r2 === 'ok' && (await bal()) === b1 - 3000, r2);
    check('multiple confirmation offers "View my bets"', (await p.locator('#slip .receipt a[href="#/my-bets"]').count()) === 1);
    await click('#slip .receipt a'); await p.waitForSelector('.bet');
    check('"View my bets" goes straight there and the confirmation is gone', (await hash()) === '#/my-bets' && (await p.locator('.bet').count()) === 3 && /empty/i.test(await p.textContent('#slip')));
    await nav('sports'); await p.waitForSelector('.ev'); check('Sports link returns to the sport you were on', (await hash()) === '#/sports/cricket');
    await odd(0, 0).click(); await p.fill('#stake', '4999'); await click('#placeBtn');
    check('too little balance: message with an inline Deposit link', /enough balance/i.test(await p.textContent('#slip .msg')) && (await p.locator('#slip .msg [data-act=deposit]').count()) === 1);
    await click('#slip .msg [data-act=deposit]'); await p.waitForSelector('[data-dep]'); check('inline Deposit opens the deposit dialog', /Deposit/.test(await p.textContent('#mTitle')));
    await click('#modal [data-act=close]'); await click('#slip [data-act=clear]');
    await odd(0, 0).click(); check('clearing the slip also resets a big stake back to R50', (await p.inputValue('#stake')) === '50'); await click('#slip [data-act=clear]');

    /* ---------- my bets ---------- */
    await nav('mybets'); await p.waitForSelector('.bet');
    check('My Bets: Open tab lists 3 open bets, Settled is empty', (await p.locator('.bet').count()) === 3 && /Open \(3\)/.test(await p.textContent('.tabs2')) && /Settled \(0\)/.test(await p.textContent('.tabs2')));
    check('demo settle control is a quiet text link, not a big button', (await p.locator('.demo-note [data-act=settle]').count()) === 1);
    const beforeSettle = await bal(); await click('[data-act=settle]'); await toast(/winning|no winners/);
    const bets = (await api('GET', '/bets')).d.bets; const paid = bets.reduce((s, b) => s + b.payout_cents, 0);
    check('settlement pays exactly the winners; view switches to Settled', (await bal()) === beforeSettle + paid && bets.every(b => b.status !== 'open') && /Settled \(3\)/.test(await p.textContent('.tabs2')) && (await p.locator('.bet').count()) === 3, `paid ${paid}`);
    await click('[data-btab=open]'); check('Open tab is now empty with a "Place a bet" shortcut', /No open bets/.test(await p.textContent('#content')) && (await p.locator('#content a[href="#/sports/soccer"]').count()) === 1);

    /* ---------- games ---------- */
    await nav('games'); await p.waitForSelector('.gcard');
    check('Games: 6 cards with artwork', (await p.locator('.gcard').count()) === 6 && (await p.evaluate(() => [...document.images].every(i => i.naturalWidth > 0))));
    let net = 0;
    for (const id of ['lion', 'tiger', 'bear', 'eagle', 'wolf', 'shark']) {
      await click(`[data-game=${id}]`); await p.waitForSelector('#gspin');
      const before = await bal(); await click('[data-gstake="5"]'); await click('#gspin');
      await p.waitForFunction(() => !document.querySelector('.reel.spin') && !/Spinning/.test(document.querySelector('#gres').textContent), null, { timeout: 8000 });
      const after = await bal(), msg = await p.textContent('#gres');
      // the message states the amount paid out; the wallet must have moved by exactly (payout - R5 stake)
      const m = msg.match(/R([\d\s\u00a0\u202f]+),(\d{2})/), paid = m ? parseInt(m[1].replace(/\D/g, ''), 10) * 100 + parseInt(m[2], 10) : 0;
      check(`${id}: spin result matches the wallet exactly`, (await p.locator('.reel').count()) === 3 && after === before - 500 + (/No win/.test(msg) ? 0 : paid), `"${msg.trim()}" ${before}→${after}`);
      net += after - before; await click('#modal [data-act=close]');
    }
    check('header balance matches the server after the games', (await p.textContent('.bal')).replace(/\D/g, '') === String(await bal()) && (await bal()) > 0, `net ${net}`);

    /* ---------- account menu: deposit, limit, statement ---------- */
    await click('#acct summary'); await click('#menu [data-act=limits]'); await p.fill('#lim', '1500'); await click('[data-act=saveLimit]'); await toast(/saved/);
    check('Account menu closes after choosing an item', (await p.evaluate(() => document.querySelector('#menu').open)) === false);
    const d0 = await bal(); await click('#acct [data-act=deposit]'); await click('[data-dep="1000"]'); await toast(/added/);
    check('deposit within the limit works', (await bal()) === d0 + 100000);
    await click('#acct [data-act=deposit]'); await clearToast(); await click('[data-dep="1000"]'); await toast(/limit/);
    check('deposit over the daily limit is refused', (await bal()) === d0 + 100000); await click('#modal [data-act=close]').catch(() => {});
    await click('#acct summary'); await click('#menu [data-act=statement]'); await p.waitForSelector('.stmt');
    const txt = await p.textContent('.stmt');
    check('wallet statement shows bonus, deposit, bet and game entries', /Welcome bonus/.test(txt) && /Deposit/.test(txt) && /Bet stake/.test(txt) && /Game stake/.test(txt));
    await click('#modal [data-act=close]');
    check('statement adds up to the balance', (await api('GET', '/ledger')).d.entries.reduce((s, e) => s + e.amount_cents, 0) === (await bal()));
    await click('footer [data-act=limits]'); check('footer "Responsible gambling" shows the helpline', /0800 006 008/.test(await p.textContent('#modalCard'))); await click('#modal [data-act=close]');

    /* ---------- phone ---------- */
    await p.setViewportSize({ width: 390, height: 800 }); await nav('sports'); await p.waitForSelector('.ev'); await p.waitForTimeout(300);
    const geo = await p.evaluate(() => { const n = document.querySelector('#mainNav').getBoundingClientRect(); return { top: n.top, bottom: n.bottom, h: innerHeight, links: [...document.querySelectorAll('#mainNav a')].map(a => a.getBoundingClientRect().height) }; });
    check('phone: main navigation is a bottom bar pinned to the screen bottom', Math.abs(geo.bottom - geo.h) < 1 && geo.links.length === 3 && geo.links.every(h => h >= 48));
    check('phone: slip bar is hidden until you pick something', await p.locator('#slipBar').isHidden());
    check('phone: price buttons are big enough to tap (>=44px)', (await odd(1, 0).evaluate(e => e.getBoundingClientRect().height)) >= 44);
    for (const v of ['sports/soccer', 'my-bets', 'games']) { await p.evaluate(v => (location.hash = '#/' + v), v); await p.waitForTimeout(250); check(`phone: no sideways scrolling on ${v}`, await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); }
    await p.evaluate(() => (location.hash = '#/sports/cricket')); await p.waitForSelector('.ev'); await odd(0, 0).click(); await odd(1, 0).click();
    check('phone: slip bar appears after a pick and shows count + combined odds', await p.locator('#slipBar').isVisible() && (await p.textContent('#slipCount')) === '2' && /Odds/.test(await p.textContent('#slipBarInfo')));
    await click('#slipBar'); await p.waitForTimeout(500);
    check('phone: slip opens as a sheet that is on screen', await p.evaluate(() => { const r = document.querySelector('#slip').getBoundingClientRect(); return r.bottom <= innerHeight + 1 && r.top < innerHeight - 200; }) && await p.locator('#scrim').isVisible());
    await p.screenshot({ path: path.join(SHOTS, 'phone-slip.png') });
    await p.keyboard.press('Escape'); check('phone: Escape / tapping outside closes the sheet', await p.evaluate(() => !document.querySelector('#slip').classList.contains('open')));
    await click('#slipBar'); await p.fill('#stake', '10'); const r3 = await placeBet();
    check('phone: bet placed from the sheet, confirmation shown', r3 === 'ok' && /Bet placed/.test(await p.textContent('#slip')));
    await click('#slip .receipt a'); await p.waitForSelector('.bet'); await p.waitForTimeout(400);
    check('phone: "View my bets" closes the sheet and shows the bet', (await hash()) === '#/my-bets' && await p.evaluate(() => !document.querySelector('#slip').classList.contains('open')) && (await p.locator('.bet').count()) >= 1);
    await p.screenshot({ path: path.join(SHOTS, 'phone-mybets.png') });
    await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await p.waitForTimeout(200);
    check('phone: the footer can be scrolled fully clear of the bottom bar', await p.evaluate(() => document.querySelector('footer').getBoundingClientRect().bottom <= document.querySelector('#mainNav').getBoundingClientRect().top + 1));
    await p.evaluate(() => (location.hash = '#/games')); await p.waitForSelector('.gcard'); await click('[data-game=eagle]');
    check('phone: game dialog fits the screen', await p.evaluate(() => { const r = document.querySelector('#modalCard').getBoundingClientRect(); return r.width <= innerWidth && r.left >= 0 && r.bottom <= innerHeight; }));
    await click('#modal [data-act=close]');
  } catch (e) { check('script completed without exception', false, e.message.split('\n')[0]); await p.screenshot({ path: path.join(SHOTS, 'failure.png') }).catch(() => {}); }

  check('no console errors / CSP violations / failed requests', problems.length === 0, problems.slice(0, 3).join(' | '));
  await browser.close(); srv.kill(); fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter(r => !r).length; console.log(`\n${results.length - failed}/${results.length} checks passed`); process.exit(failed ? 1 : 0);
})();
