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
  const srv = spawn('node', ['--disable-warning=ExperimentalWarning', path.join(__dirname, '../server/server.js')], { env: { ...process.env, PORT, DB_PATH: path.join(dir, 'e2e.db'), AUTO_APPROVE_MAX_CENTS: '20000', PAYOUT_SEND_MS: '600', PAYOUT_PAID_MS: '1200' }, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 1500));
  const browser = await chromium.launch(); const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } }); await ctx.grantPermissions(['clipboard-read', 'clipboard-write']); const p = await ctx.newPage();
  const problems = []; p.on('pageerror', e => problems.push('pageerror: ' + e.message));
  // Chrome logs every 4xx API reply as a console error; the test provokes some on purpose, so ignore only those.
  p.on('console', m => { const t = m.text(); if (/status of (400|401|403|409|422)/.test(t)) return; if (m.type() === 'error' || /Content Security Policy/i.test(t)) problems.push('console: ' + t); });
  p.on('requestfailed', r => problems.push('requestfailed: ' + r.url()));
  // every request for prices, so the test can see how often the page asks and for how much
  const polls = []; let loads = 0; p.on('load', () => loads++);
  p.on('request', r => { const u = new URL(r.url()); if (u.pathname === '/api/events' || u.pathname === '/api/odds') polls.push({ t: Date.now(), path: u.pathname, q: u.search }); });
  const since = t => polls.filter(x => x.t >= t);

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
  const fillAuth = async (u, pw, dob, terms, limit = '2500') => { await p.fill('input[name=username]', u); await p.fill('input[name=password]', pw); if (dob) { await p.fill('input[name=dob]', dob); await p.check(`input[name=limit][value="${limit}"]`); if (terms) await p.check('input[name=terms]'); } await click('#authForm button'); };
  const cents = async sel => Number((await p.textContent(sel)).replace(/\D/g, ''));   // "R1 234,50" -> 123450
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
    const tLive = Date.now(), clock0 = await p.textContent('.ev .live'); await p.waitForTimeout(5800);
    check('light refresh: a live page asks only for the moving numbers of its live matches', since(tLive).length >= 1 && since(tLive).every(x => (x.path === '/api/odds' && x.q === '?ids=e0,e8') || (x.path === '/api/events' && x.q === '?live=1')), since(tLive).map(x => x.path + x.q).join(' '));
    check('live clock advances', (await p.textContent('.ev .live')) !== clock0, `${clock0.trim()} → ${(await p.textContent('.ev .live')).trim()}`);
    check('prices refresh IN PLACE (buttons are never replaced, so a tap is never lost)', await p.evaluate(() => document.querySelector('.odd').__keep === true));
    await nav('mybets'); check('My Bets: asks you to log in', /Log in to see your bets/.test(await p.textContent('#content')));
    const tQuiet = Date.now(); await p.waitForTimeout(11000);
    check('light refresh: with no price on show (My Bets, empty slip) nothing is fetched at all', since(tQuiet).length === 0, since(tQuiet).map(x => x.path + x.q).join(' '));
    await p.goBack(); await p.waitForSelector('.ev'); check('Back button returns to the previous page', (await hash()) === '#/sports/live');
    const tCricket = Date.now(); await tab('cricket'); await p.waitForTimeout(11000);
    const cr = since(tCricket);
    check('light refresh: a sport with no live match is fetched once on opening, then left alone', cr.length >= 1 && cr.length <= 2 && cr.every(x => x.path === '/api/events' && x.q === '?sport=cricket'), cr.map(x => x.path + x.q).join(' '));
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
    await click('footer [data-act=limits]');
    check('logged out: "Responsible gambling" shows the helpline and asks you to log in', /0800 006 008/.test(await p.textContent('#modalCard')) && /Log in to set a deposit limit/.test(await p.textContent('#modalCard')));
    await click('#modal [data-act=close]');
    await click('#acct [data-act=join]');
    check('sign-up offers a daily deposit limit with nothing pre-selected', (await p.locator('input[name=limit]').count()) === 6 && (await p.locator('input[name=limit]:checked').count()) === 0);
    await p.fill('input[name=username]', 'kid'); await p.fill('input[name=password]', 'correct horse');
    await p.fill('input[name=dob]', new Date(Date.now() - 12 * 365 * 864e5).toISOString().slice(0, 10)); await p.check('input[name=terms]'); await click('#authForm button');
    check('sign-up cannot be sent until a limit is chosen', (await p.evaluate(() => document.querySelector('#authForm').checkValidity())) === false && (await api('GET', '/me')).d.user === null);
    await p.check('input[name=limit][value="2500"]'); await click('#authForm button');
    await p.waitForFunction(() => /18/.test(document.querySelector('#authErr').textContent)); check('under-18 registration rejected', true);
    await p.fill('input[name=dob]', '1990-04-04'); await p.fill('input[name=username]', 'Hunter'); await p.fill('input[name=password]', 'correct horse');
    await click('#authForm button'); await p.waitForSelector('.bal');
    check('registration works: R1 000 play money, and the chosen R2 500 limit is saved', (await bal()) === 100000 && /1\D?000/.test(await p.textContent('.bal')) && (await api('GET', '/me')).d.deposit_limit_cents === 250000);
    check('slip pick survived logging in', (await p.locator('#slip .pick').count()) === 1);
    check('header after login is just: balance, Deposit, Account', (await p.locator('#acct button:visible').allTextContents()).join('|') === 'Deposit' && await p.locator('#acct .bal').isVisible() && (await p.textContent('#acct summary')) === 'Account');
    await click('#acct summary');
    check('Account menu: Withdraw, My spending, Limits & breaks, Log out', (await p.locator('#menu .menu-pop button').allTextContents()).join('|') === 'Withdraw|My spending|Limits & breaks|Log out');
    await click('#menu [data-act=logout]'); await p.waitForSelector('#acct [data-act=login]');
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

    /* ---------- sharing a bet ---------- */
    const pickedCode = pg => pg.$$eval('.odd.sel', els => els.map(e => `${e.dataset.ev}-${e.dataset.mk}-${e.dataset.k}`).join('_'));
    await click('#slip [data-act=shareSlip]'); await p.waitForSelector('#waShare');
    const code = await pickedCode(p), shareUrl = await p.inputValue('#shareLink'), waHref = await p.getAttribute('#waShare', 'href'), wa = decodeURIComponent(waHref.split('text=')[1]);
    check('share: the slip becomes a link that carries exactly these picks', shareUrl === `${BASE}/?bet=${code}` && code.split('_').length === 2 && (await p.locator('.share-list li').count()) === 2, shareUrl);
    check('share: the WhatsApp button carries a readable message with the link, and no name or stake', waHref.startsWith('https://wa.me/?text=') && wa.includes(shareUrl) && /^My 2 ApexBets picks: /.test(wa) && /18\+ only\.$/.test(wa) && !/Hunter|R\d/.test(wa), wa);
    await clearToast(); await click('[data-act=copyShare]'); await toast(/copied/);
    check('share: "Copy link" puts the link on the clipboard', (await p.evaluate(() => navigator.clipboard.readText())) === shareUrl);
    await click('#modal [data-act=close]');
    check('share: sharing changes nothing on the slip', (await p.locator('#slip .pick').count()) === 2 && (await pickedCode(p)) === code);

    const ctxB = await browser.newContext({ viewport: { width: 390, height: 800 } }); const q = await ctxB.newPage();     // a friend opening the link on a phone
    q.on('pageerror', e => problems.push('pageerror (visitor): ' + e.message));
    q.on('console', m => { const t = m.text(); if ((m.type() === 'error' && !/status of (400|401|403|409|422)/.test(t)) || /Content Security Policy/i.test(t)) problems.push('console (visitor): ' + t); });
    await q.goto(shareUrl); await q.waitForSelector('#slip .pick');
    check('shared link: the same picks arrive on the visitor\'s slip, highlighted in the list', (await q.locator('#slip .pick').count()) === 2 && (await pickedCode(q)) === code);
    check('shared link: the address is tidied, so reloading does not add the picks again', !/bet=/.test(q.url()) && /#\/sports\/cricket$/.test(q.url()));
    await q.waitForTimeout(450);
    check('shared link: on a phone the slip opens by itself and says where the picks came from', (await q.evaluate(() => { const r = document.querySelector('#slip').getBoundingClientRect(); return document.querySelector('#slip').classList.contains('open') && r.top < innerHeight - 200; })) && /2 picks from a shared bet/.test(await q.textContent('#slip .msg')));
    check('shared link: nothing is placed for the visitor; they set a stake and log in first', /Log in to place bet/.test(await q.textContent('#placeBtn')) && (await q.inputValue('#stake')) === '50' && (await q.evaluate(async () => (await (await fetch('/api/me')).json()).user)) === null);
    await q.screenshot({ path: path.join(SHOTS, 'phone-shared-arrival.png') });
    await q.goto(`${BASE}/?bet=${code.split('_')[0]}_zz9-w-h`); await q.waitForSelector('#slip .pick');
    check('shared link: a pick that no longer exists is left out, and the visitor is told', (await q.locator('#slip .pick').count()) === 1 && /1 of 2 shared picks added\. One is no longer available/.test(await q.textContent('#slip .msg')));
    await q.goto(`${BASE}/?bet=${encodeURIComponent('<img src=x onerror=alert(1)>')}`); await q.waitForSelector('.ev');
    await q.waitForFunction(() => /no longer available/.test(document.querySelector('#toast').textContent));
    check('shared link: a broken or tampered link adds nothing and breaks nothing', (await q.locator('#slip .pick').count()) === 0 && !/bet=/.test(q.url()) && (await q.locator('img[src="x"]').count()) === 0);
    await ctxB.close();

    const b0 = await bal(); await p.fill('#stake', '1'); await click('#placeBtn');
    check('stake below the minimum: clear message on the slip, nothing charged', /minimum/i.test(await p.textContent('#slip .msg')) && (await bal()) === b0);
    await p.fill('#stake', '20'); check('typing a stake updates the numbers without losing focus', await p.evaluate(() => document.activeElement.id === 'stake') && /20,00/.test(await p.textContent('#placeBtn')) && /20,00/.test(await p.textContent('#retVal')) === false);
    await click('#slip [data-mode=single]'); check('Singles: total stake is per-pick x picks', /40,00/.test(await p.textContent('#stakeTot')));
    const r1 = await placeBet();
    check('two singles placed; clear confirmation on the slip', r1 === 'ok' && (await bal()) === b0 - 4000 && /Bet placed/.test(await p.textContent('#slip .receipt')) && (await p.locator('#slip .receipt a[href="#/my-bets"]').count()) === 1, `${r1}`);
    check('open-bet count appears on My Bets in the nav', (await p.textContent('#openBadge')) === '2');
    await click('#slip [data-act=shareReceipt]'); await p.waitForSelector('#shareLink');
    check('share: the bet just placed can be shared from its confirmation', (await p.inputValue('#shareLink')) === shareUrl);
    await click('#modal [data-act=close]');
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
    check('My Bets: every open bet can be shared', (await p.locator('.bet [data-sharebet]').count()) === 3);
    await p.locator('.bet [data-sharebet]').first().click(); await p.waitForSelector('#shareLink');
    check('My Bets: sharing the 3-pick multiple gives a link with its 3 picks', (await p.locator('.share-list li').count()) === 3 && (await p.inputValue('#shareLink')).split('bet=')[1].split('_').length === 3);
    await click('#modal [data-act=close]');
    const beforeSettle = await bal(); await click('[data-act=settle]'); await toast(/winning|no winners/);
    const bets = (await api('GET', '/bets')).d.bets; const paid = bets.reduce((s, b) => s + b.payout_cents, 0);
    check('settlement pays exactly the winners; view switches to Settled', (await bal()) === beforeSettle + paid && bets.every(b => b.status !== 'open') && /Settled \(3\)/.test(await p.textContent('.tabs2')) && (await p.locator('.bet').count()) === 3, `paid ${paid}`);
    check('My Bets: settled bets are not offered for sharing', (await p.locator('[data-sharebet]').count()) === 0);
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
    await click('#acct summary'); await click('#menu [data-act=limits]'); await p.waitForSelector('#limNow');
    check('Account menu closes after choosing an item', (await p.evaluate(() => document.querySelector('#menu').open)) === false);
    check('Stay in control shows the limit chosen at sign-up', /2\D?500,00 a day/.test(await p.textContent('#limNow')));
    await p.fill('#lim', '1500'); await click('[data-act=saveLimit]'); await p.waitForSelector('#limNote');
    check('lowering the limit applies at once', /applies now/.test(await p.textContent('#limNote')) && /1\D?500,00 a day/.test(await p.textContent('#limNow')) && (await api('GET', '/me')).d.deposit_limit_cents === 150000);
    await p.fill('#lim', '5000'); await click('[data-act=saveLimit]'); await p.waitForSelector('#limPending');
    const pend = (await api('GET', '/me')).d;
    check('raising the limit waits 24 hours: the old limit still applies and the change is shown', /1\D?500,00 a day/.test(await p.textContent('#limNow')) && /5\D?000,00 a day/.test(await p.textContent('#limPending')) && pend.deposit_limit_cents === 150000 && pend.pending_limit.cents === 500000 && pend.pending_limit.at > Date.now() + 23 * 36e5);
    await click('[data-act=cancelLimit]'); await p.waitForFunction(() => !document.querySelector('#limPending'));
    check('a pending increase can be cancelled', (await api('GET', '/me')).d.pending_limit === null);
    await p.fill('#lim', '5'); await click('[data-act=saveLimit]'); await p.waitForFunction(() => document.querySelector('#limErr').textContent.length > 0);
    check('a limit below the minimum deposit is refused with a reason', /at least R10/.test(await p.textContent('#limErr')) && (await api('GET', '/me')).d.deposit_limit_cents === 150000);
    await click('#modal [data-act=close]');
    const d0 = await bal(); await click('#acct [data-act=deposit]'); await click('[data-dep="1000"]'); await toast(/added/);
    check('deposit within the limit works', (await bal()) === d0 + 100000);
    await click('#acct [data-act=deposit]'); await clearToast(); await click('[data-dep="1000"]'); await toast(/limit/);
    check('deposit over the daily limit is refused', (await bal()) === d0 + 100000); await click('#modal [data-act=close]').catch(() => {});
    await click('#acct summary'); await click('#menu [data-act=spending]'); await p.waitForSelector('#verdict');
    const st = (await api('GET', '/statement')).d;
    check('My spending: this month in plain words, matching the server', (await cents('#spStaked')) === st.staked_cents && (await cents('#spReturned')) === st.returned_cents && (await cents('#spDeposited')) === st.deposited_cents && st.deposited_cents === 100000 && /^You are (down|up|even)/.test(await p.textContent('#verdict')), await p.textContent('#verdict'));
    check('My spending explains the whole balance', (await bal()) === st.bonus_cents + st.deposited_cents - st.withdrawn_cents + st.result_cents);
    await click('#modal [data-act=statement]'); await p.waitForSelector('.stmt');
    const txt = await p.textContent('.stmt');
    check('All transactions lists bonus, deposit, bet and game entries', /Welcome bonus/.test(txt) && /Deposit/.test(txt) && /Bet stake/.test(txt) && /Game stake/.test(txt));
    await click('#modal [data-act=spending]'); await p.waitForSelector('#verdict'); check('"Back to My spending" returns to the summary', (await p.locator('.stmt').count()) === 0);
    await click('#modal [data-act=close]');
    check('statement adds up to the balance', (await api('GET', '/ledger')).d.entries.reduce((s, e) => s + e.amount_cents, 0) === (await bal()));
    await click('footer [data-act=limits]'); check('footer "Responsible gambling" opens the same controls, with the helpline', /0800 006 008/.test(await p.textContent('#modalCard')) && (await p.locator('#lim').count()) === 1); await click('#modal [data-act=close]');

    /* ---------- withdrawals ---------- */
    const play = n => p.evaluate(async n => { for (let i = 0; i < n; i++) await fetch('/api/games/play', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ game: 'bear', stake_cents: 1000 }) }); }, n);
    const openWithdraw = async () => { await click('#acct summary'); await click('#menu [data-act=withdraw]'); await p.waitForSelector('#wdForm > *'); };
    await openWithdraw();
    check('withdraw: first asks for a bank account (10 banks to choose from)', (await p.locator('#bankForm select option').count()) === 11 && (await p.locator('#wdReq').count()) === 0);
    await p.selectOption('#bankForm select', 'Capitec'); await p.fill('#bankForm input[name=account_number]', '12ab'); await p.fill('#bankForm input[name=holder]', 'Hunter Mokoena'); await click('#bankForm button');
    check('withdraw: a malformed account number cannot be sent', (await p.evaluate(() => document.querySelector('#bankForm').checkValidity())) === false && (await api('GET', '/me')).d.payout_account === null);
    await p.fill('#bankForm input[name=account_number]', '1234567890'); await click('#bankForm button'); await p.waitForSelector('#wdReq');
    const m1 = (await api('GET', '/me')).d;
    check('withdraw: the account is saved and shown by its last 4 digits only', /Withdraw to Capitec ••7890/.test(await p.textContent('#wdBtn')) && !(await p.content()).includes('1234567890') && m1.payout_account.last4 === '7890');
    check('withdraw: money not yet bet is held back, and the screen says how much', (await cents('#wdCan')) === m1.withdrawable_cents && m1.unplayed_cents > 0 && /Still to bet/.test(await p.textContent('#wdUnplayed')), `available ${m1.withdrawable_cents}, still to bet ${m1.unplayed_cents}`);
    await p.fill('#wdAmt', String(Math.floor(m1.balance_cents / 100) - 1)); await click('#wdBtn'); await p.waitForFunction(() => document.querySelector('#wdErr').textContent.length > 0);
    check('withdraw: asking for money that has not been bet is refused with the reason', /bet once/.test(await p.textContent('#wdErr')) && (await bal()) === m1.balance_cents && (await p.locator('.wd').count()) === 0);
    await click('#modal [data-act=close]');
    await play(Math.ceil(m1.unplayed_cents / 1000)); await p.reload(); await p.waitForSelector('.bal');       // bet the rest once (through the API, to save time)

    await openWithdraw(); await p.waitForSelector('#wdReq');
    const m2 = (await api('GET', '/me')).d;
    check('withdraw: once it has been bet, the whole balance is available', m2.unplayed_cents === 0 && (await cents('#wdCan')) === m2.balance_cents && (await p.locator('#wdUnplayed').count()) === 0, `balance ${m2.balance_cents}`);
    await click('[data-wq="100"]'); check('withdraw: a quick amount fills the field', (await p.inputValue('#wdAmt')) === '100');
    await click('#wdBtn'); await p.waitForSelector('.wd');
    check('R100: approved automatically, the balance drops at once and the tracker appears', (await bal()) === m2.balance_cents - 10000 && (await cents('.bal')) === m2.balance_cents - 10000 && /Approved automatically/.test(await p.textContent('.wd .track')) && /Sending to your bank|Sent to your bank/.test(await p.textContent('.wd .track')) && (await p.inputValue('#wdAmt')) === '');
    await p.screenshot({ path: path.join(SHOTS, 'withdraw-in-progress.png') });
    await p.waitForSelector('.wd.paid', { timeout: 15000 });
    const paidTrack = await p.textContent('.wd.paid .track');
    check('tracker: every step ticks off, ending in "Paid" with the time it took', (await p.locator('.wd.paid .track li.done').count()) === 4 && /Sent to your bank/.test(paidTrack) && /Paid in \d+ seconds?/.test(paidTrack) && /Paid/.test(await p.textContent('.wd.paid .tag')), paidTrack.replace(/\s+/g, ' ').trim());
    await p.waitForSelector('#wdStats');
    check('our real payout times are published on the withdraw screen', /Last 30 days: half of all withdrawals were paid within \d+ seconds?/.test(await p.textContent('#wdStats')));

    await p.fill('#wdAmt', '250'); await click('#wdBtn'); await p.waitForSelector('.wd.review');
    check('R250 (over the automatic amount in this test) waits for a person, and says so', /Being checked by a person/.test(await p.textContent('.wd.review .track')) && /over R200 are checked by a person/.test(await p.textContent('.wd.review')) && (await bal()) === m2.balance_cents - 35000);
    await click('[data-act=changeBank]'); await p.selectOption('#bankForm select', 'FNB'); await p.fill('#bankForm input[name=account_number]', '62000011112'); await click('#bankForm button');
    await p.waitForFunction(() => document.querySelector('#bankErr').textContent.length > 0);
    check('the bank account is locked while a withdrawal is in progress', /once your current withdrawal has finished/.test(await p.textContent('#bankErr')) && (await api('GET', '/me')).d.payout_account.bank === 'Capitec');
    await click('[data-act=cancelBank]'); await p.waitForSelector('#wdReq');
    await p.waitForTimeout(2500); check('a withdrawal being checked does not move on by itself', (await p.locator('.wd.review').count()) === 1);
    await click('.wd.review [data-ok="1"]'); await p.waitForFunction(() => document.querySelectorAll('.wd.paid').length === 2, null, { timeout: 15000 });
    check('once approved by a person it is paid, and the record says so', /Approved after a check/.test(await p.textContent('.wd.paid >> nth=0')) && (await bal()) === m2.balance_cents - 35000);

    await click('[data-act=changeBank]'); await p.selectOption('#bankForm select', 'Nedbank'); await p.fill('#bankForm input[name=account_number]', '5550000000'); await click('#bankForm button'); await p.waitForSelector('#wdReq');
    check('the bank account can be changed when nothing is in progress', /Nedbank ••0000/.test(await p.textContent('#wdBtn')));
    const b3 = await bal(); await p.fill('#wdAmt', '50'); await click('#wdBtn'); await p.waitForSelector('.wd.failed', { timeout: 15000 });
    await p.waitForFunction(b => Number(document.querySelector('.bal').textContent.replace(/\D/g, '')) === b, b3);
    check('a payout the bank rejects comes straight back, and the tracker says why', /Rejected by your bank/.test(await p.textContent('.wd.failed .track')) && /back in your balance/.test(await p.textContent('.wd.failed .msg')) && (await bal()) === b3 && (await cents('#wdCan')) === b3);
    await p.screenshot({ path: path.join(SHOTS, 'withdraw-history.png') });
    await click('#modal [data-act=close]');
    await click('#acct summary'); await click('#menu [data-act=spending]'); await p.waitForSelector('#verdict');
    check('My spending counts only the money that really left (R350)', (await cents('#spWithdrawn')) === 35000);
    await click('#modal [data-act=statement]'); await p.waitForSelector('.stmt');
    check('All transactions shows the withdrawals and the returned one', /Withdrawal #/.test(await p.textContent('.stmt')) && /Withdrawal returned #/.test(await p.textContent('.stmt')));
    await click('#modal [data-act=close]');

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
    await click('#slip [data-act=shareReceipt]'); await p.waitForSelector('#waShare'); await p.waitForTimeout(150);
    check('phone: the share screen fits, on top of the bet slip', await p.evaluate(() => { const r = document.querySelector('#modalCard').getBoundingClientRect(), top = document.elementFromPoint(innerWidth / 2, r.top + 30); return r.width <= innerWidth && r.left >= 0 && document.documentElement.scrollWidth <= innerWidth && !!top.closest('#modalCard'); }));
    await p.screenshot({ path: path.join(SHOTS, 'phone-share.png') }); await click('#modal [data-act=close]');
    await click('#slip .receipt a'); await p.waitForSelector('.bet'); await p.waitForTimeout(400);
    check('phone: "View my bets" closes the sheet and shows the bet', (await hash()) === '#/my-bets' && await p.evaluate(() => !document.querySelector('#slip').classList.contains('open')) && (await p.locator('.bet').count()) >= 1);
    await p.screenshot({ path: path.join(SHOTS, 'phone-mybets.png') });
    await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await p.waitForTimeout(200);
    check('phone: the footer can be scrolled fully clear of the bottom bar', await p.evaluate(() => document.querySelector('footer').getBoundingClientRect().bottom <= document.querySelector('#mainNav').getBoundingClientRect().top + 1));
    await p.evaluate(() => (location.hash = '#/games')); await p.waitForSelector('.gcard'); await click('[data-game=eagle]');
    check('phone: game dialog fits the screen', await p.evaluate(() => { const r = document.querySelector('#modalCard').getBoundingClientRect(); return r.width <= innerWidth && r.left >= 0 && r.bottom <= innerHeight; }));
    await click('#modal [data-act=close]');

    await click('#acct summary'); await click('#menu [data-act=withdraw]'); await p.waitForSelector('#wdReq'); await p.waitForTimeout(200);
    check('phone: the withdraw screen fits, with no sideways scrolling', await p.evaluate(() => { const r = document.querySelector('#modalCard').getBoundingClientRect(); return r.width <= innerWidth && r.left >= 0 && document.documentElement.scrollWidth <= innerWidth && document.querySelector('#modalCard').scrollWidth <= document.querySelector('#modalCard').clientWidth; }));
    await p.screenshot({ path: path.join(SHOTS, 'phone-withdraw.png') }); await click('#modal [data-act=close]');

    /* ---------- taking a break (last: it cannot be undone) ---------- */
    await p.setViewportSize({ width: 1280, height: 900 }); await nav('sports'); await p.waitForSelector('.ev'); await odd(0, 0).click();
    await click('#acct summary'); await click('#menu [data-act=limits]'); await p.waitForSelector('#breakOpts');
    check('break: three lengths offered, and nothing starts until one is chosen and confirmed', (await p.locator('#breakOpts button').allTextContents()).join('|') === '24 hours|7 days|30 days' && (await p.locator('[data-act=startBreak]').count()) === 0 && await p.locator('#notice').isHidden());
    await click('[data-break="24"]'); await p.waitForSelector('[data-act=startBreak]');
    check('break: the confirm button says exactly what will happen', /Start a 24-hour break/.test(await p.textContent('[data-act=startBreak]')));
    const balB = await bal(); await click('[data-act=startBreak]'); await p.waitForSelector('#breakNow');
    const meB = (await api('GET', '/me')).d;
    check('break: starts, and is shown at the top of every page', meB.break_until > Date.now() + 23 * 36e5 && await p.locator('#notice').isVisible() && /on a break until/i.test(await p.textContent('#notice')));
    await click('#modal [data-act=close]');
    check('break: the bet slip is paused and says why', (await p.isDisabled('#placeBtn')) && /On a break/.test(await p.textContent('#placeBtn')) && /on a break until/i.test(await p.textContent('#slip .msg')) && (await p.locator('#slip [data-act=shareSlip]').count()) === 0);
    await click('#acct [data-act=deposit]'); await p.waitForSelector('#modalCard .msg');
    check('break: deposits are paused', /paused/.test(await p.textContent('#modalCard')) && (await p.locator('[data-dep]').count()) === 0); await click('#modal [data-act=close]');
    check('break: the server refuses deposits, bets and games as well', (await api('POST', '/deposit', { amount_cents: 10000 })).s === 403 && (await api('POST', '/games/play', { game: 'lion', stake_cents: 500 })).s === 403 && (await bal()) === balB);
    await nav('mybets'); check('break: the notice follows you to other pages', await p.locator('#notice').isVisible());
    const bw = await bal(), wOnBreak = await api('POST', '/withdrawals', { amount_cents: 5000 });
    check('break: you can still take your money out', wOnBreak.s === 201 && (await bal()) === bw - 5000);
    await p.setViewportSize({ width: 390, height: 800 }); await p.waitForTimeout(250);
    check('break: phone layout still has no sideways scrolling with the notice', await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await p.screenshot({ path: path.join(SHOTS, 'phone-break.png') });

    /* ---------- real-money mode: no casino games ---------- */
    const PORT2 = PORT + 1000;
    const srv2 = spawn('node', ['--disable-warning=ExperimentalWarning', path.join(__dirname, '../server/server.js')], { env: { ...process.env, PORT: PORT2, DB_PATH: path.join(dir, 'real.db'), DEMO_MODE: 'false' }, stdio: 'ignore' });
    await new Promise(r => setTimeout(r, 1500));
    try {
      const p2 = await ctx.newPage(); await p2.setViewportSize({ width: 1280, height: 900 });
      await p2.goto(`http://localhost:${PORT2}/#/games`); await p2.waitForSelector('.ev');
      check('real-money mode: Games is not offered (2 nav items; #/games falls back to Sports)', (await p2.$$eval('#mainNav a:not([hidden]) > span', a => a.map(x => x.textContent.trim()))).join('|') === 'Sports|My Bets' && /Soccer|Sports/.test(await p2.textContent('h1')));
      await p2.close();
    } finally { srv2.kill(); }
  } catch (e) { check('script completed without exception', false, e.message.split('\n')[0]); await p.screenshot({ path: path.join(SHOTS, 'failure.png') }).catch(() => {}); }

  check('light refresh: the full match list is fetched only when the page itself loads', polls.filter(x => x.path === '/api/events' && !x.q).length === loads, `${polls.filter(x => x.path === '/api/events' && !x.q).length} full fetches, ${loads} page loads, ${polls.length} price requests in all`);
  check('no console errors / CSP violations / failed requests', problems.length === 0, problems.slice(0, 3).join(' | '));
  await browser.close(); srv.kill(); fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter(r => !r).length; console.log(`\n${results.length - failed}/${results.length} checks passed`); process.exit(failed ? 1 : 0);
})();
