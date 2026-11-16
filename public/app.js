/* ApexBets front end. Display only: odds, balances, bets and game results all come from the server API. */
(() => {
'use strict';

const MIN_STAKE = 5, MAX_STAKE = 5000, MAX_LEGS = 12, DEFAULT_STAKE = 50;          // rand; the server enforces the real limits
const TZ = 'Africa/Johannesburg';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const R = cents => 'R' + (cents / 100).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const SPORTS = [
  { id: 'soccer', name: 'Soccer', icon: '⚽' }, { id: 'rugby', name: 'Rugby', icon: '🏉' },
  { id: 'cricket', name: 'Cricket', icon: '🏏' }, { id: 'tennis', name: 'Tennis', icon: '🎾' },
  { id: 'basketball', name: 'Basketball', icon: '🏀' },
];

/* ---------- state ---------- */
let config = { demo: true, games: true, break_hours: [24, 168, 720], limit_cooloff_hours: 24 };   // what this server offers (real-money mode has no casino games)
let events = [], prevOdds = {}, me = null, bets = [], games = [], gameLimits = { min: 100, max: 50000 };
const ui = { view: 'sports', sport: 'soccer', betsTab: 'open', slip: [], mode: 'multi', stake: DEFAULT_STAKE, slipOpen: false, busy: false, msg: null, receipt: null };
let lastFocus = null;

async function api(method, path, body) {
  try {
    const opt = { method, credentials: 'same-origin' };
    if (method !== 'GET') { opt.headers = { 'Content-Type': 'application/json' }; opt.body = JSON.stringify(body || {}); }
    const r = await fetch('/api' + path, opt);
    return { status: r.status, ok: r.ok, data: await r.json().catch(() => ({})) };
  } catch { return { status: 0, ok: false, data: { message: 'Cannot reach the server' } }; }
}
const setMe = d => { me = d && d.user ? d : null; };

/* ---------- helpers ---------- */
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2800); }
const dayKey = ms => new Intl.DateTimeFormat('en-ZA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
const hm = ms => new Date(ms).toLocaleTimeString('en-ZA', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
function whenText(ms) {
  const k = dayKey(ms);
  if (k === dayKey(Date.now())) return `Today ${hm(ms)}`;
  if (k === dayKey(Date.now() + 864e5)) return `Tomorrow ${hm(ms)}`;
  return new Date(ms).toLocaleDateString('en-ZA', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' }) + ' ' + hm(ms);
}
const fmtWhen = ms => new Date(ms).toLocaleDateString('en-ZA', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' }) + ', ' + hm(ms);
const onBreak = () => !!(me && me.break_until && me.break_until > Date.now());
const LIMIT_CHOICES = [100, 250, 500, 1000, 2500];                  // rand a day, offered at sign-up
const findSel = (evId, mk, k) => {
  const e = events.find(x => x.id === evId), m = e && e.markets.find(x => x.key === mk), s = m && m.sels.find(x => x.k === k);
  return s ? { e, m, s } : null;
};
const inSlip = (id, mk, k) => ui.slip.some(s => s.ev === id && s.mk === mk && s.k === k);
const totalOdds = () => Math.round(ui.slip.reduce((a, s) => a * (findSel(s.ev, s.mk, s.k)?.s.odds || 1), 1) * 100) / 100;   // same rounding as the server
const stakeCents = () => Math.round((Number(ui.stake) || 0) * 100);
const isMulti = () => ui.mode === 'multi' && ui.slip.length > 1;
const oddsNow = key => { const [e, m, k] = key.split('|'); return findSel(e, m, k)?.s.odds; };
const moveOf = key => { const now = oddsNow(key), p = prevOdds[key]; return p && now && p !== now ? (now > p ? 'up' : 'down') : ''; };
// A fresh bet always starts from the default stake, so a big stake never carries over by accident.
const resetSlip = () => { ui.slip = []; ui.mode = 'multi'; ui.stake = DEFAULT_STAKE; ui.msg = null; };
const syncSelected = () => $$('.odd[data-ev]').forEach(b => { const on = inSlip(b.dataset.ev, b.dataset.mk, b.dataset.k); b.classList.toggle('sel', on); b.setAttribute('aria-pressed', on); });

/* ---------- header, navigation ---------- */
function renderAcct() {
  document.body.dataset.auth = me ? 'in' : 'out';                    // lets the phone header drop the wordmark to make room for balance + Deposit
  $('#acct').innerHTML = me
    ? `<span class="bal" aria-label="Balance">${R(me.balance_cents)}</span>
       <button class="btn primary" data-act="deposit">Deposit</button>
       <details class="menu" id="menu"><summary>Account</summary><div class="menu-pop">
         <button data-act="spending">My spending</button><button data-act="limits">Limits &amp; breaks</button><button data-act="logout">Log out</button></div></details>`
    : '<button class="btn" data-act="login">Log in</button><button class="btn primary" data-act="join">Join</button>';
  const notice = $('#notice'), brk = onBreak();                      // a break is shown on every page, not hidden in a menu
  notice.hidden = !brk;
  notice.innerHTML = brk ? `You're on a break until <strong>${esc(fmtWhen(me.break_until))}</strong>. Betting and deposits are paused.` : '';
}
function renderNav() {
  $$('#mainNav a').forEach(a => a.dataset.nav === ui.view ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'));
  $('#mainNav a[data-nav=games]').hidden = !config.games;
  const sportsLink = $('#mainNav a[data-nav=sports]'); sportsLink.setAttribute('href', `#/sports/${ui.sport}`);   // "Sports" returns to your last sport
  const open = bets.filter(b => b.status === 'open').length, badge = $('#openBadge');
  badge.hidden = !(me && open); badge.textContent = open;
}

/* ---------- sports ---------- */
function sportTabs() {
  const liveN = events.filter(e => e.live).length;
  const tab = (id, label, on) => `<a href="#/sports/${id}"${on ? ' aria-current="page"' : ''}>${label}</a>`;
  return `<nav class="sport-tabs" aria-label="Sports">${tab('live', `<i class="dot"></i>Live${liveN ? ` <small>${liveN}</small>` : ''}`, ui.sport === 'live')}${SPORTS.map(s => tab(s.id, `${s.icon} ${s.name}`, ui.sport === s.id)).join('')}</nav>`;
}
function oddBtnInner(key, odds) {
  const mv = moveOf(key), arrow = mv === 'up' ? '▲' : mv === 'down' ? '▼' : '';
  return (arrow ? `<span class="ar" aria-hidden="true">${arrow}</span>` : '') + odds.toFixed(2);
}
function oddBtn(e, m, s) {
  const key = `${e.id}|${m.key}|${s.k}`, on = inSlip(e.id, m.key, s.k), mv = moveOf(key);
  const label = s.k === 'd' ? 'Draw' : `${s.label} to win`;
  return `<button class="odd${on ? ' sel' : ''}${mv ? ' ' + mv : ''}" ${e.closed ? 'disabled' : ''} data-ev="${e.id}" data-mk="${m.key}" data-k="${s.k}" aria-pressed="${on}" aria-label="${esc(label)} at ${s.odds.toFixed(2)}">${oddBtnInner(key, s.odds)}</button>`;
}
const metaHtml = e => e.live ? `<span class="live">● LIVE ${e.minute}'</span>${e.closed ? ' · Full time' : ''}` : esc(whenText(e.start));
function eventRow(e) {
  const m = e.markets[0], sc = e.score;
  return `<div class="ev" data-id="${e.id}"><div><div class="ev-meta">${metaHtml(e)}</div>
    <div class="t"><span>${esc(e.home)}</span>${sc ? `<span class="sc" data-side="0">${sc[0]}</span>` : ''}</div>
    <div class="t"><span>${esc(e.away)}</span>${sc ? `<span class="sc" data-side="1">${sc[1]}</span>` : ''}</div></div>
    <div class="odds">${m.sels.map(s => oddBtn(e, m, s)).join('')}</div></div>`;
}
function renderSports() {
  const live = ui.sport === 'live', sp = SPORTS.find(s => s.id === ui.sport);
  const list = events.filter(e => (live ? e.live : e.sport === ui.sport));
  const byLeague = {};
  [...list].sort((a, b) => b.live - a.live || a.start - b.start).forEach(e => (byLeague[e.league] ||= []).push(e));
  const blocks = Object.entries(byLeague).map(([lg, evs]) => {
    const cols = evs[0].markets[0].sels.length === 3 ? ['1', 'X', '2'] : ['1', '2'];
    return `<section class="league"><div class="league-h"><span>${esc(lg)}</span><span class="cols">${cols.map(c => `<span>${c}</span>`).join('')}</span></div>${evs.map(eventRow).join('')}</section>`;
  }).join('');
  return `${sportTabs()}<div class="page-h"><h1>${live ? 'Live now' : esc(sp.name)}</h1><span class="hint">1 = home win · X = draw · 2 = away win · times in SAST</span></div>` +
    (blocks || `<div class="empty">${live ? 'No live matches right now.' : 'No matches available.'}</div>`);
}

/* ---------- my bets ---------- */
function renderBets() {
  const head = '<div class="page-h"><h1>My Bets</h1></div>';
  if (!me) return head + '<div class="empty">Log in to see your bets.<br><button class="btn primary" data-act="login">Log in</button></div>';
  const open = bets.filter(b => b.status === 'open'), settled = bets.filter(b => b.status !== 'open');
  const list = ui.betsTab === 'open' ? open : settled;
  const tabs = `<div class="tabs2" role="group" aria-label="Bet status"><button data-btab="open" aria-pressed="${ui.betsTab === 'open'}">Open (${open.length})</button><button data-btab="settled" aria-pressed="${ui.betsTab === 'settled'}">Settled (${settled.length})</button></div>`;
  const cards = list.map(b => `<article class="bet ${b.status}"><header><span>${b.type === 'multi' ? `Multiple · ${b.legs.length} picks` : 'Single'} <span class="when">#${b.id} · ${new Date(b.created_at).toLocaleString('en-ZA', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })}</span></span><span class="tag ${b.status}">${b.status}</span></header>
    <ul>${b.legs.map(l => `<li>${esc(l.label)} @ ${l.odds.toFixed(2)} – <em>${esc(l.match)}</em>${l.result ? ` (${l.result})` : ''}</li>`).join('')}</ul>
    <div class="bet-sum"><span>Stake ${R(b.stake_cents)} · Odds ${b.odds.toFixed(2)}</span><strong>${b.status === 'won' ? 'Returned ' + R(b.payout_cents) : b.status === 'lost' ? 'Lost' : 'To return ' + R(Math.floor(b.stake_cents * b.odds))}</strong></div></article>`).join('');
  const none = `<div class="empty">${ui.betsTab === 'open' ? 'No open bets.' : 'No settled bets yet.'}<br><a class="btn primary" href="#/sports/soccer">Place a bet</a></div>`;
  const demo = me.demo && open.length && ui.betsTab === 'open' ? '<p class="demo-note">Demo only: <button class="linkbtn" data-act="settle">settle my open bets with random results</button></p>' : '';
  return head + tabs + (cards || none) + demo;
}

/* ---------- games ---------- */
function renderGames() {
  return `<div class="page-h"><h1>Games</h1><span class="hint">Play-money demo games · every spin is decided on the server</span></div>
    <div class="games-grid">${games.map(g => `<button class="gcard" data-game="${g.id}"><img src="${g.image}" alt="${esc(g.name)}" width="256" height="256">
      <div class="gb"><h3>${esc(g.name)}</h3><p>${esc(g.tagline)}</p>
      <div class="chipset"><span class="chip ${g.volatility === 'Low' ? 'lo' : g.volatility === 'High' ? 'hi' : ''}">${esc(g.volatility)} volatility</span><span class="chip">RTP ${g.rtp}%</span></div></div></button>`).join('')}</div>`;
}

function syncLayout() {                                            // desktop: only show the bet slip where it is useful
  const l = $('.layout'); l.dataset.view = ui.view; l.dataset.slip = ui.slip.length || ui.receipt ? 'on' : 'off';
}
function renderContent() { syncLayout(); $('#content').innerHTML = ui.view === 'mybets' ? renderBets() : ui.view === 'games' ? renderGames() : renderSports(); }

/* ---------- bet slip ---------- */
function slipTotals() {
  const n = ui.slip.length, multi = isMulti(), stake = stakeCents(), total = multi ? stake : stake * n;
  const ret = multi ? Math.floor(stake * totalOdds()) : ui.slip.reduce((a, x) => a + Math.floor(stake * (findSel(x.ev, x.mk, x.k)?.s.odds || 0)), 0);
  return { n, multi, stake, total, ret };
}
function updateTotals() {                                          // update numbers in place so typing never loses focus
  if (!ui.slip.length || ui.receipt) return;
  const { total, ret, multi } = slipTotals(), set = (id, t) => { const el = $('#' + id); if (el) el.textContent = t; };
  set('retVal', R(ret)); set('stakeTot', R(total)); if (multi) set('oddsTot', totalOdds().toFixed(2));
  const pb = $('#placeBtn'); if (pb && !ui.busy && !onBreak()) pb.textContent = me ? `Place bet · ${R(total)}` : 'Log in to place bet';
  $('#slipBarInfo').textContent = barInfo();
}
const barInfo = () => (isMulti() ? `Odds ${totalOdds().toFixed(2)} · ` : '') + 'View ›';
function renderSlip() {
  syncLayout();
  const s = $('#slip'), n = ui.slip.length;
  s.classList.toggle('open', ui.slipOpen); $('#scrim').hidden = !ui.slipOpen;
  $('#slipCount').textContent = n; $('#slipBarInfo').textContent = barInfo();
  $('#slipBar').hidden = !n || ui.slipOpen || !!ui.receipt;
  const head = `<div class="slip-h"><h2>Bet slip${n && !ui.receipt ? ` <span class="count">${n}</span>` : ''}</h2>${n && !ui.receipt ? '<button class="linkbtn" data-act="clear">Clear all</button>' : ''}<button class="icon-btn sheet-only" data-act="closeSlip" aria-label="Close bet slip">✕</button></div>`;
  if (ui.receipt) {
    s.innerHTML = head + `<div class="slip-b receipt"><div class="tick" aria-hidden="true">✔</div><h3>Bet placed</h3>
      <p>${ui.receipt.n === 1 ? '1 bet' : ui.receipt.n + ' bets'} · stake ${R(ui.receipt.total)}. Good luck!</p>
      <a class="btn primary block" href="#/my-bets" data-act="closeSlip">View my bets</a><button class="linkbtn block" data-act="newbet">Keep betting</button></div>`;
    return;
  }
  if (!n) { s.innerHTML = head + '<div class="slip-b slip-empty"><b>Your bet slip is empty</b>Tap a price to add it.</div>'; return; }
  const { multi, total, ret } = slipTotals();
  const rows = ui.slip.map(x => { const f = findSel(x.ev, x.mk, x.k); if (!f) return '';
    const mv = moveOf(`${x.ev}|${x.mk}|${x.k}`);
    return `<div class="pick" data-pick="${x.ev}"><div class="pick-main"><div class="pick-name">${esc(f.s.label)}</div><div class="pick-sub">${esc(f.m.name)} · ${esc(f.e.home)} v ${esc(f.e.away)}</div></div>
      <div class="pick-odds ${mv}">${f.s.odds.toFixed(2)}</div><button class="icon-btn" data-rm="${x.ev}" aria-label="Remove ${esc(f.s.label)}">✕</button></div>`; }).join('');
  const brk = onBreak();
  const msg = brk ? `<div class="msg warn" role="alert">You're on a break until ${esc(fmtWhen(me.break_until))}. You can place bets again after that.</div>`
    : ui.msg ? `<div class="msg ${ui.msg.type}" role="alert">${esc(ui.msg.text)}${ui.msg.action === 'deposit' ? ' <button class="linkbtn" data-act="deposit">Deposit</button>' : ''}</div>` : '';
  s.innerHTML = head + `<div class="slip-b">
    ${n > 1 ? `<div class="seg" role="group" aria-label="Bet type"><button data-mode="multi" aria-pressed="${multi}">Multiple</button><button data-mode="single" aria-pressed="${!multi}">Singles</button></div>` : ''}
    ${rows}
    <label class="field"><span>Stake${n > 1 && !multi ? ' per bet' : ''} (R)</span><input id="stake" type="number" inputmode="decimal" min="${MIN_STAKE}" max="${MAX_STAKE}" step="1" value="${esc(ui.stake)}"></label>
    <div class="chips">${[20, 50, 100].map(v => `<button data-q="${v}">R${v}</button>`).join('')}</div>
    <dl class="sum">${multi ? `<div><dt>Total odds</dt><dd id="oddsTot">${totalOdds().toFixed(2)}</dd></div>` : ''}${n > 1 && !multi ? `<div><dt>Total stake</dt><dd id="stakeTot">${R(total)}</dd></div>` : ''}
      <div class="ret"><dt>To return</dt><dd id="retVal">${R(ret)}</dd></div></dl>
    ${msg}
    <button class="btn primary block" id="placeBtn" data-act="place" ${ui.busy || brk ? 'disabled' : ''}>${brk ? 'On a break' : ui.busy ? 'Placing…' : me ? `Place bet · ${R(total)}` : 'Log in to place bet'}</button></div>`;
}
function patchSlip() {                                             // refresh prices without replacing the slip's buttons
  $$('#slip [data-pick]').forEach(row => {
    const x = ui.slip.find(s => s.ev === row.dataset.pick), f = x && findSel(x.ev, x.mk, x.k); if (!f) return;
    const el = $('.pick-odds', row), mv = moveOf(`${x.ev}|${x.mk}|${x.k}`);
    el.textContent = f.s.odds.toFixed(2); el.className = 'pick-odds' + (mv ? ' ' + mv : '');
  });
  updateTotals();
}
function patchOdds() {                                             // update prices, clocks and scores in place (taps are never lost)
  $$('.odd[data-ev]').forEach(b => {
    const f = findSel(b.dataset.ev, b.dataset.mk, b.dataset.k); if (!f) return;
    const key = `${b.dataset.ev}|${b.dataset.mk}|${b.dataset.k}`, mv = moveOf(key);
    b.innerHTML = oddBtnInner(key, f.s.odds); b.disabled = f.e.closed;
    b.classList.toggle('up', mv === 'up'); b.classList.toggle('down', mv === 'down');
    b.setAttribute('aria-label', `${f.s.k === 'd' ? 'Draw' : f.s.label + ' to win'} at ${f.s.odds.toFixed(2)}`);
  });
  $$('.ev[data-id]').forEach(row => {
    const e = events.find(x => x.id === row.dataset.id); if (!e) return;
    $('.ev-meta', row).innerHTML = metaHtml(e);
    if (e.score) $$('.sc', row).forEach(sc => (sc.textContent = e.score[sc.dataset.side]));
  });
}
const setMsg = (type, text, action) => { ui.msg = { type, text, action }; renderSlip(); };
const renderAll = () => { renderNav(); renderAcct(); renderContent(); renderSlip(); };

/* ---------- data ---------- */
async function loadEvents() {
  const r = await api('GET', '/events'); if (!r.ok) return false;
  const old = {}; events.forEach(e => e.markets.forEach(m => m.sels.forEach(s => (old[`${e.id}|${m.key}|${s.k}`] = s.odds))));
  prevOdds = old; events = r.data.events;
  const before = ui.slip.length; ui.slip = ui.slip.filter(x => findSel(x.ev, x.mk, x.k));
  return ui.slip.length !== before;                                // true if the slip itself changed
}
async function loadGames() { const r = await api('GET', '/games'); if (r.ok) { games = r.data.games; gameLimits = { min: r.data.min_stake_cents, max: r.data.max_stake_cents }; } }
async function loadBets() { if (!me) { bets = []; return; } const r = await api('GET', '/bets'); if (r.ok) bets = r.data.bets; }

/* ---------- actions ---------- */
function toggleSel(ev, mk, k) {
  ui.receipt = null; ui.msg = null;
  const i = ui.slip.findIndex(s => s.ev === ev);
  if (i >= 0 && ui.slip[i].mk === mk && ui.slip[i].k === k) ui.slip.splice(i, 1);
  else if (i >= 0) ui.slip[i] = { ev, mk, k };                      // one pick per match
  else { if (ui.slip.length >= MAX_LEGS) return toast(`Maximum ${MAX_LEGS} picks`); ui.slip.push({ ev, mk, k }); }
  if (!ui.slip.length) resetSlip();
  syncSelected(); renderSlip();
}
async function place() {
  if (!me) return openAuth('login');
  const { multi, stake, total } = slipTotals();
  if (stake < MIN_STAKE * 100) return setMsg('error', `The minimum stake is R${MIN_STAKE}.`);
  if (stake > MAX_STAKE * 100) return setMsg('error', `The maximum stake is R${MAX_STAKE}.`);
  if (total > me.balance_cents) return setMsg('error', 'You don’t have enough balance for this bet.', 'deposit');
  ui.busy = true; ui.msg = null; renderSlip();
  const r = await api('POST', '/bets', { type: multi ? 'multi' : 'single', stake_cents: stake,
    selections: ui.slip.map(x => ({ ev: x.ev, mk: x.mk, k: x.k, odds: findSel(x.ev, x.mk, x.k).s.odds })) });
  ui.busy = false;
  if (r.ok) { setMe(r.data); ui.receipt = { n: r.data.bet_ids.length, total }; resetSlip(); await loadBets(); syncSelected(); renderNav(); renderAcct(); renderSlip(); if (ui.view === 'mybets') renderContent(); return; }
  if (r.status === 409) { await loadEvents(); if (ui.view === 'sports') patchOdds(); return setMsg('warn', 'Prices just changed. Your slip now shows the new prices – check them and place your bet again.'); }
  if (r.status === 401) { me = null; renderAll(); return openAuth('login'); }
  if (r.data.error === 'on_break') { const m = await api('GET', '/me'); setMe(m.data); renderAcct(); return renderSlip(); }   // break started elsewhere
  setMsg('error', r.data.message || 'Could not place the bet.', r.data.error === 'insufficient_funds' ? 'deposit' : undefined);
}

/* ---------- modals ---------- */
function modal(html) { if ($('#modal').hidden) lastFocus = document.activeElement;   // one dialog replacing another keeps the original return point
  $('#modalCard').innerHTML = html; $('#modal').hidden = false; const i = $('#modalCard input:not([type=checkbox]),#modalCard button'); i && i.focus(); }
function closeModal() { $('#modal').hidden = true; if (lastFocus && document.contains(lastFocus)) lastFocus.focus(); lastFocus = null; }
function openAuth(mode) {
  const reg = mode === 'register';
  modal(`<h2 id="mTitle">${reg ? 'Create your account' : 'Log in'}</h2>
    ${reg && config.demo ? '<p class="warn-text">Demo site: you get R1 000 of play money. A real operator must verify your RSA ID (FICA) before you can bet.</p>' : ''}
    <form id="authForm" data-mode="${mode}">
      <label class="field"><span>Username</span><input name="username" required minlength="3" maxlength="24" autocomplete="username"></label>
      <label class="field"><span>Password${reg ? ' (at least 8 characters)' : ''}</span><input name="password" type="password" required minlength="${reg ? 8 : 1}" maxlength="128" autocomplete="${reg ? 'new-password' : 'current-password'}"></label>
      ${reg ? `<label class="field"><span>Date of birth</span><input name="dob" type="date" required></label>
        <fieldset class="limit-pick"><legend>Your daily deposit limit</legend>
          <div class="radio-chips">${LIMIT_CHOICES.map(v => `<label><input type="radio" name="limit" value="${v}" required><span>R${v.toLocaleString('en-ZA')}</span></label>`).join('')}<label><input type="radio" name="limit" value="0" required><span>No limit</span></label></div>
          <p class="warn-text">The most you can deposit in one day. You can lower it at any time. Raising it takes ${config.limit_cooloff_hours} hours.</p></fieldset>
        <label class="check"><input type="checkbox" name="terms" required> I am 18 or older and accept the (demo) terms.</label>` : ''}
      <div class="err" id="authErr" role="alert"></div>
      <button class="btn primary block">${reg ? 'Create account' : 'Log in'}</button></form>
    <p class="warn-text center">${reg ? 'Already have an account?' : 'New here?'} <button class="linkbtn" data-act="${reg ? 'login' : 'join'}">${reg ? 'Log in' : 'Create an account'}</button></p>`);
}
function openDeposit() {
  if (onBreak()) return modal(`<h2 id="mTitle">Deposit</h2><p class="msg warn">You're on a break until <strong>${esc(fmtWhen(me.break_until))}</strong>. Deposits are paused until then.</p><button class="btn block" data-act="close">Close</button>`);
  const lim = me.deposit_limit_cents;
  modal(`<h2 id="mTitle">Deposit</h2><p class="warn-text">Demo: adds play money only, no real payment is taken.${lim ? ` Daily limit ${R(lim)} · ${R(Math.max(0, lim - me.deposited_today_cents))} left today.` : ''}</p>
    <div class="chips">${[100, 500, 1000, 2500].map(v => `<button data-dep="${v}">R${v}</button>`).join('')}</div>
    <button class="btn block" data-act="close">Cancel</button>`);
}
let breakPick = null;
const breakLabel = h => (h === 24 ? '24 hours' : `${h / 24} days`);
function limitsHtml(note, error) {
  const help = '<p class="warn-text">Gambling can be addictive. For free, confidential help call the South African Responsible Gambling Foundation on <strong>0800 006 008</strong>.</p>';
  if (!me) return `<h2 id="mTitle">Stay in control</h2>${help}<p class="warn-text">Log in to set a deposit limit or take a break.</p>
    <button class="btn primary block" data-act="login">Log in</button><button class="btn block mt8" data-act="close">Close</button>`;
  const lim = me.deposit_limit_cents, pend = me.pending_limit, brk = onBreak();
  return `<h2 id="mTitle">Stay in control</h2>
    <section class="ctl"><h3>Daily deposit limit</h3>
      <p class="ctl-now" id="limNow">${lim ? `${R(lim)} a day · ${R(Math.max(0, lim - me.deposited_today_cents))} left today` : 'No limit'}</p>
      ${pend ? `<p class="msg warn" id="limPending">Changes to ${pend.cents ? R(pend.cents) + ' a day' : 'no limit'} on ${esc(fmtWhen(pend.at))}. <button class="linkbtn" data-act="cancelLimit">Cancel the change</button></p>` : ''}
      <label class="field"><span>New limit (R a day, 0 = no limit)</span><input id="lim" type="number" inputmode="numeric" min="0" step="1" value="${lim / 100}"></label>
      <div class="err" id="limErr" role="alert">${error ? esc(error) : ''}</div>
      <button class="btn primary block" data-act="saveLimit">Save limit</button>
      ${note ? `<p class="ok-text" id="limNote" role="status">${esc(note)}</p>` : ''}
      <p class="warn-text">A lower limit applies straight away. A higher limit starts after ${config.limit_cooloff_hours} hours.</p>
    </section>
    <section class="ctl"><h3>Take a break</h3>
      ${brk ? `<p class="msg warn" id="breakNow">You're on a break until <strong>${esc(fmtWhen(me.break_until))}</strong>. Betting and deposits are paused. You can make it longer.</p>`
            : '<p class="warn-text">Pause betting and deposits. A break cannot be ended early.</p>'}
      <div class="chips" id="breakOpts">${config.break_hours.map(h => `<button data-break="${h}" aria-pressed="${breakPick === h}">${breakLabel(h)}</button>`).join('')}</div>
      ${breakPick ? `<button class="btn primary block" data-act="startBreak">Start a ${breakPick === 24 ? '24-hour' : breakPick / 24 + '-day'} break</button>` : ''}
    </section>
    ${help}
    <button class="btn block mt8" data-act="close">Close</button>`;
}
function openLimits() { breakPick = null; modal(limitsHtml()); }
const redrawLimits = (note, error) => { $('#modalCard').innerHTML = limitsHtml(note, error); };

/* ---------- my spending: the plain monthly statement ---------- */
async function openSpending(month) {
  const r = await api('GET', '/statement' + (month ? `?month=${month}` : '')); if (!r.ok) return toast('Could not load your spending');
  const s = r.data, i = s.months.indexOf(s.month);                   // months are newest first
  const newer = i > 0 ? s.months[i - 1] : null, older = i >= 0 && i < s.months.length - 1 ? s.months[i + 1] : null;
  const name = new Date(`${s.month}-15T12:00:00Z`).toLocaleDateString('en-ZA', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const res = s.result_cents, played = s.bets + s.game_rounds > 0;
  const verdict = !played ? 'No bets this month' : res < 0 ? `You are down ${R(-res)}` : res > 0 ? `You are up ${R(res)}` : 'You are even';
  const what = [s.bets ? `${s.bets} bet${s.bets > 1 ? 's' : ''}` : '', s.game_rounds ? `${s.game_rounds} game round${s.game_rounds > 1 ? 's' : ''}` : ''].filter(Boolean).join(', ');
  const html = `<h2 id="mTitle">My spending</h2>
    <div class="month-nav"><button class="icon-btn" ${older ? `data-month="${older}"` : 'disabled'} aria-label="Earlier month">‹</button><strong id="spMonth">${esc(name)}</strong><button class="icon-btn" ${newer ? `data-month="${newer}"` : 'disabled'} aria-label="Later month">›</button></div>
    <p class="verdict ${!played ? '' : res < 0 ? 'down' : res > 0 ? 'up' : ''}" id="verdict">${verdict}</p>
    <dl class="kv">
      <div><dt>You staked${what ? ` (${what})` : ''}</dt><dd id="spStaked">${R(s.staked_cents)}</dd></div>
      <div><dt>You got back</dt><dd id="spReturned">${R(s.returned_cents)}</dd></div>
      <div><dt>Deposited</dt><dd id="spDeposited">${R(s.deposited_cents)}</dd></div>
      <div><dt>Withdrawn</dt><dd id="spWithdrawn">${R(s.withdrawn_cents)}</dd></div>
      ${s.bonus_cents ? `<div><dt>Play-money credit</dt><dd>${R(s.bonus_cents)}</dd></div>` : ''}
    </dl>
    <button class="btn block" data-act="statement">All transactions</button>
    <button class="btn block mt8" data-act="close">Close</button>`;
  if ($('#modal').hidden) modal(html); else $('#modalCard').innerHTML = html;   // moving between months redraws in place
}
async function openStatement() {
  const r = await api('GET', '/ledger'); if (!r.ok) return toast('Could not load the statement');
  const label = { bonus: 'Welcome bonus', deposit: 'Deposit', bet_stake: 'Bet stake', bet_payout: 'Bet winnings', game_stake: 'Game stake', game_win: 'Game win' };
  modal(`<h2 id="mTitle">All transactions</h2><p class="warn-text">Balance ${R(me.balance_cents)}. Every movement is recorded and can never be edited. <button class="linkbtn" data-act="spending">Back to My spending</button></p>
    <table class="stmt">${r.data.entries.map(e => `<tr><td>${new Date(e.created_at).toLocaleString('en-ZA', { dateStyle: 'short', timeStyle: 'short' })}</td><td>${esc(label[e.kind] || e.kind)}${e.ref ? ' ' + esc(e.ref.replace(/^(bet|round):/, '#')) : ''}</td>
      <td class="${e.amount_cents < 0 ? 'neg' : 'pos'}">${e.amount_cents < 0 ? '−' : '+'}${R(Math.abs(e.amount_cents))}</td></tr>`).join('') || '<tr><td>No transactions</td></tr>'}</table>
    <button class="btn block mt8" data-act="close">Close</button>`);
}
async function deposit(rands) {
  const r = await api('POST', '/deposit', { amount_cents: rands * 100 });
  if (r.ok) { setMe(r.data); ui.msg = null; closeModal(); renderAcct(); renderSlip(); toast(`${R(rands * 100)} added`); } else toast(r.data.message || 'Deposit failed');
}

/* ---------- games ---------- */
const gs = { id: null, stake: 10, spinning: false };
function openGame(id) {
  const g = games.find(x => x.id === id); if (!g) return;
  gs.id = id; gs.spinning = false;
  modal(`<div class="gm"><img src="${g.image}" alt="${esc(g.name)}"><h2 id="mTitle">${esc(g.name)}</h2>
    <p class="warn-text">${esc(g.tagline)} · RTP ${g.rtp}% · ${esc(g.volatility)} volatility</p>
    <div class="reels" aria-live="polite"><div class="reel" id="r0">${g.animal}</div><div class="reel" id="r1">${g.animal}</div><div class="reel" id="r2">${g.animal}</div></div>
    <div class="gresult" id="gres">Choose a stake and spin</div>
    <div class="chips" id="gq">${[5, 10, 50, 100].map(v => `<button data-gstake="${v}" class="${gs.stake === v ? 'on' : ''}">R${v}</button>`).join('')}</div>
    <button class="btn primary block" data-act="spin" id="gspin">${me ? `Spin · R${gs.stake}` : 'Log in to play'}</button>
    <details><summary>Paytable</summary><table class="pt">
      ${g.symbols.map((sy, i) => `<tr><td>${sy} ${sy} ${sy}</td><td>${g.pay3[i]}×</td></tr>`).join('')}
      <tr><td>Pair on reels 1–2</td><td>${Math.min(...g.pay2)}×–${Math.max(...g.pay2)}×</td></tr><tr><td>${g.animal} anywhere</td><td>${g.pay1}×</td></tr></table></details>
    <button class="btn block mt8" data-act="close">Close</button></div>`);
}
async function spin() {
  const g = games.find(x => x.id === gs.id); if (!g || gs.spinning) return;
  if (!me) return openAuth('login');
  const stake = gs.stake * 100;
  if (stake < gameLimits.min || stake > gameLimits.max) return toast('Stake out of range');
  gs.spinning = true; $('#gspin').disabled = true; $('#gres').textContent = 'Spinning…'; $('#gres').className = 'gresult';
  const reels = [0, 1, 2].map(i => $('#r' + i)); reels.forEach(r => r.classList.add('spin'));
  const anim = setInterval(() => reels.forEach(r => (r.textContent = g.symbols[Math.floor(Math.random() * g.symbols.length)])), 90);
  const [r] = await Promise.all([api('POST', '/games/play', { game: g.id, stake_cents: stake }), new Promise(ok => setTimeout(ok, 900))]);
  clearInterval(anim); gs.spinning = false;
  if ($('#modal').hidden || gs.id !== g.id || !$('#r0')) return;     // closed mid-spin
  reels.forEach(x => x.classList.remove('spin')); $('#gspin').disabled = false;
  if (!r.ok) { reels.forEach(x => (x.textContent = g.animal)); $('#gres').textContent = r.data.message || 'Could not play'; if (r.status === 401) { setMe(null); renderAll(); } return; }
  r.data.reels.forEach((sym, i) => (reels[i].textContent = g.symbols[sym]));
  setMe(r.data); renderAcct();
  const res = $('#gres');
  res.textContent = !r.data.payout_cents ? 'No win – try again' : r.data.mult < 1 ? `Got back ${R(r.data.payout_cents)} of your ${R(stake)}` : r.data.mult === 1 ? `Stake returned ${R(r.data.payout_cents)}` : `Win ${R(r.data.payout_cents)} (${r.data.mult}×)`;
  res.className = 'gresult' + (r.data.mult > 1 ? ' win' : '');
}

/* ---------- routing: the address bar always says where you are, and Back works ---------- */
function parseHash() {
  const [a, b] = location.hash.replace(/^#\/?/, '').split('/');
  if (a === 'my-bets') return { view: 'mybets' };
  if (a === 'games' && config.games) return { view: 'games' };
  if (a === 'sports' && (b === 'live' || SPORTS.some(s => s.id === b))) return { view: 'sports', sport: b };
  return { view: 'sports', sport: 'soccer' };
}
async function route() {
  const r = parseHash(); ui.view = r.view; if (r.sport) ui.sport = r.sport;
  ui.receipt = null; ui.slipOpen = false;                           // moving on: the confirmation has done its job, and Back closes the phone sheet
  if (ui.view === 'mybets') await loadBets();
  renderAll(); window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

/* ---------- events ---------- */
document.addEventListener('click', async e => {
  const menu = $('#menu'); if (menu && menu.open && !menu.contains(e.target)) menu.open = false;
  const t = e.target.closest('button, a[data-act]');
  if (!t) { if (e.target.id === 'modal') closeModal(); if (e.target.id === 'scrim') { ui.slipOpen = false; renderSlip(); } return; }
  if (menu && t.closest('.menu-pop')) menu.open = false;
  const d = t.dataset;
  if (d.ev && d.mk) return toggleSel(d.ev, d.mk, d.k);
  if (d.rm) { ui.slip = ui.slip.filter(s => s.ev !== d.rm); if (!ui.slip.length) resetSlip(); else { if (ui.slip.length < 2) ui.mode = 'multi'; ui.msg = null; } syncSelected(); return renderSlip(); }
  if (d.mode) { ui.mode = d.mode; ui.msg = null; return renderSlip(); }
  if (d.q) { ui.stake = Number(d.q); const i = $('#stake'); if (i) i.value = ui.stake; ui.msg = null; const m = $('#slip .msg'); if (m) m.remove(); return updateTotals(); }
  if (d.btab) { ui.betsTab = d.btab; return renderContent(); }
  if (d.dep) return deposit(Number(d.dep));
  if (d.month) return openSpending(d.month);
  if (d.break) { breakPick = Number(d.break); return redrawLimits(); }
  if (d.gstake) { gs.stake = Number(d.gstake); $$('#gq button').forEach(b => b.classList.toggle('on', b.dataset.gstake === d.gstake)); const sp = $('#gspin'); if (sp && me) sp.textContent = `Spin · R${gs.stake}`; return; }
  if (d.game) return openGame(d.game);
  switch (d.act) {
    case 'join': return openAuth('register');
    case 'login': return openAuth('login');
    case 'deposit': closeModal(); return me && openDeposit();
    case 'limits': return openLimits();
    case 'statement': return openStatement();
    case 'spending': return openSpending();
    case 'saveLimit': {
      const r = await api('PUT', '/limits', { deposit_limit_cents: Math.round((Number($('#lim').value) || 0) * 100) });
      if (!r.ok) return redrawLimits(null, r.data.message || 'Could not save the limit.');
      setMe(r.data); renderAcct();
      return redrawLimits(r.data.pending_limit ? `Saved. Your higher limit starts on ${fmtWhen(r.data.pending_limit.at)}.` : 'Limit saved. It applies now.');
    }
    case 'cancelLimit': { const r = await api('PUT', '/limits', { deposit_limit_cents: me.deposit_limit_cents }); if (r.ok) { setMe(r.data); redrawLimits('The change was cancelled.'); } return; }
    case 'startBreak': {
      const r = await api('POST', '/break', { hours: breakPick }); if (!r.ok) return redrawLimits(null, r.data.message || 'Could not start the break.');
      setMe(r.data); breakPick = null; renderAcct(); renderSlip(); return redrawLimits();
    }
    case 'logout': await api('POST', '/logout'); me = null; bets = []; ui.receipt = null; ui.msg = null; renderAll(); return;
    case 'clear': resetSlip(); syncSelected(); return renderSlip();
    case 'place': return place();
    case 'spin': return spin();
    case 'settle': { const r = await api('POST', '/bets/settle-demo'); if (r.ok) { setMe(r.data); await loadBets(); ui.betsTab = 'settled'; renderAll(); toast(r.data.won ? `${r.data.won} winning bet${r.data.won > 1 ? 's' : ''}!` : 'Results in – no winners this time'); } return; }
    case 'close': return closeModal();
    case 'openSlip': ui.slipOpen = true; return renderSlip();
    case 'closeSlip': ui.slipOpen = false; return renderSlip();
    case 'newbet': ui.receipt = null; ui.slipOpen = false; return renderSlip();
  }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') { if (!$('#modal').hidden) closeModal(); else if (ui.slipOpen) { ui.slipOpen = false; renderSlip(); } } });
document.addEventListener('input', e => { if (e.target.id === 'stake') { ui.stake = e.target.value; ui.msg = null; const m = $('#slip .msg'); if (m) m.remove(); updateTotals(); } });
document.addEventListener('submit', async e => {
  if (e.target.id !== 'authForm') return; e.preventDefault();
  const f = new FormData(e.target), reg = e.target.dataset.mode === 'register';
  const body = { username: f.get('username').trim(), password: f.get('password') };
  if (reg) { body.dob = f.get('dob'); body.terms = f.get('terms') === 'on'; body.deposit_limit_cents = f.get('limit') === null ? null : Number(f.get('limit')) * 100; }
  const btn = e.target.querySelector('button'); btn.disabled = true;
  const r = await api('POST', reg ? '/register' : '/login', body);
  if (!r.ok) { btn.disabled = false; $('#authErr').textContent = r.data.message || 'Something went wrong'; return; }
  setMe(r.data); await loadBets(); closeModal(); renderAll(); toast(reg ? `Welcome, ${me.user.username}!${config.demo ? ' R1 000 play money added.' : ''}` : `Welcome back, ${me.user.username}`);
});

/* ---------- boot ---------- */
(async () => {
  const c = await api('GET', '/config'); if (c.ok) config = c.data;
  const [m] = await Promise.all([api('GET', '/me'), loadEvents(), config.games ? loadGames() : null]);
  setMe(m.data); await loadBets();
  if (!location.hash) history.replaceState(null, '', '#/sports/soccer');
  const r = parseHash(); ui.view = r.view; if (r.sport) ui.sport = r.sport;
  renderAll();
  setInterval(async () => {                                        // live refresh: patch in place, never re-draw under the user's finger
    if (document.hidden) return;
    const slipChanged = await loadEvents();
    if (ui.view === 'sports') patchOdds();
    if (slipChanged) renderSlip(); else patchSlip();
  }, 5000);
})();
})();
