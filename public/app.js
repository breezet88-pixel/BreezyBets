/* ApexBets front end. All odds, balances and bets live on the server; this file only displays them. */
(() => {
'use strict';

const MIN_STAKE = 5, MAX_STAKE = 5000, MAX_LEGS = 12;   // rands (server enforces the real limits)
const $ = (s, r = document) => r.querySelector(s);
const R = cents => 'R' + (cents / 100).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const SPORTS = [
  { id: 'soccer', name: 'Soccer', icon: '⚽' }, { id: 'rugby', name: 'Rugby', icon: '🏉' },
  { id: 'cricket', name: 'Cricket', icon: '🏏' }, { id: 'tennis', name: 'Tennis', icon: '🎾' },
  { id: 'basketball', name: 'Basketball', icon: '🏀' },
];

/* ---------- state ---------- */
let events = [];
let prevOdds = {};                       // "evId|mk|k" -> previous price, for up/down colouring
let me = null;                           // {user, balance_cents, deposit_limit_cents, ...} or null
let bets = [];
let games = [], gameLimits = { min: 100, max: 50000 };
const ui = { view: 'games', sport: 'soccer', slip: [], mode: 'single', stake: 50, slipOpen: false, busy: false };

async function api(method, path, body) {
  try {
    const r = await fetch('/api' + path, { method, headers: body ? { 'Content-Type': 'application/json' } : (method === 'GET' ? {} : { 'Content-Type': 'application/json' }), body: body ? JSON.stringify(body) : (method === 'GET' ? undefined : '{}'), credentials: 'same-origin' });
    return { status: r.status, ok: r.ok, data: await r.json().catch(() => ({})) };
  } catch { return { status: 0, ok: false, data: { message: 'Cannot reach the server' } }; }
}
const setMe = d => { me = d && d.user ? d : null; };

/* ---------- helpers ---------- */
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2800); }
const fmtTime = ms => new Date(ms).toLocaleString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Johannesburg' }) + ' SAST';
const findSel = (evId, mk, k) => {
  const e = events.find(x => x.id === evId); const m = e && e.markets.find(x => x.key === mk); const s = m && m.sels.find(x => x.k === k);
  return s ? { e, m, s } : null;
};
const inSlip = (id, mk, k) => ui.slip.some(s => s.ev === id && s.mk === mk && s.k === k);
const slipOdds = () => ui.slip.reduce((a, s) => a * (findSel(s.ev, s.mk, s.k)?.s.odds || 1), 1);
const stakeCents = () => Math.round((Number(ui.stake) || 0) * 100);

/* ---------- render ---------- */
function renderAcct() {
  $('#acct').innerHTML = me
    ? `<span class="bal" title="Play money">${R(me.balance_cents)}</span>
       <button class="btn primary" data-act="deposit">Deposit</button>
       <button class="btn" data-act="logout" title="Log out ${esc(me.user.username)}">Log out</button>`
    : `<button class="btn" data-act="login">Log in</button><button class="btn primary" data-act="join">Join now</button>`;
}
function renderSide() {
  $('#side').innerHTML = '<h3>Sports</h3>' + SPORTS.map(s => {
    const n = events.filter(e => e.sport === s.id).length;
    return `<button data-sport="${s.id}" class="${ui.sport === s.id && ui.view === 'sports' ? 'active' : ''}"><span>${s.icon} ${s.name}</span><span class="n">${n}</span></button>`;
  }).join('') + `<h3>Casino</h3><button data-view="games" class="${ui.view === 'games' ? 'active' : ''}"><span>🐾 Apex Games</span><span class="n">${games.length}</span></button><h3>Account</h3><button data-act="limits"><span>🛡️ Responsible gambling</span></button>${me ? '<button data-act="statement"><span>🧾 Wallet statement</span></button>' : ''}`;
}
function oddBtn(e, m, s) {
  const prev = prevOdds[`${e.id}|${m.key}|${s.k}`], on = inSlip(e.id, m.key, s.k);
  const cls = (on ? ' sel' : '') + (prev && prev !== s.odds ? (s.odds > prev ? ' up' : ' down') : '');
  return `<button class="odd${cls}" ${e.closed ? 'disabled' : ''} data-ev="${e.id}" data-mk="${m.key}" data-k="${s.k}" aria-pressed="${on}" aria-label="${esc(s.label)} at ${s.odds.toFixed(2)}"><small>${esc(s.short)}</small><b>${s.odds.toFixed(2)}</b></button>`;
}
function evCard(e) {
  const sc = e.score;
  return `<div class="ev"><div>
      <div class="meta">${e.live ? `<span class="live">● LIVE ${e.minute}'</span>${e.closed ? ' · Full time' : ''}` : fmtTime(e.start)}</div>
      <div class="team"><span>${esc(e.home)}</span><span class="sc">${sc ? sc[0] : ''}</span></div>
      <div class="team"><span>${esc(e.away)}</span><span class="sc">${sc ? sc[1] : ''}</span></div>
    </div><div>${e.markets.map(m => `<div class="odds${m.key !== 'w' ? ' mt6' : ''}">${m.sels.map(s => oddBtn(e, m, s)).join('')}</div>`).join('')}</div></div>`;
}
function renderContent() {
  const c = $('#content');
  if (ui.view === 'mybets') return (c.innerHTML = renderBets());
  if (ui.view === 'games') return (c.innerHTML = renderGames());
  const list = ui.view === 'live' ? events.filter(e => e.live) : events.filter(e => e.sport === ui.sport);
  const sp = SPORTS.find(s => s.id === ui.sport);
  const byLeague = {};
  [...list].sort((a, b) => b.live - a.live || a.start - b.start).forEach(e => (byLeague[e.league] ||= []).push(e));
  const title = ui.view === 'live' ? 'Live now' : `${sp.icon} ${sp.name}`;
  c.innerHTML = `<div class="hero"><div><h2>${title}</h2><p>${ui.view === 'live' ? 'Odds and scores update automatically (simulated).' : 'Sample fixtures with simulated odds. Pick a price to add it to your bet slip.'}</p></div>
      ${me ? '' : '<button class="btn primary" data-act="join">Join &amp; get R1 000 demo credit</button>'}</div>` +
    (Object.keys(byLeague).length ? Object.entries(byLeague).map(([lg, evs]) =>
      `<section class="league"><h3><span>${esc(lg)}</span><span>${evs.length}</span></h3>${evs.map(evCard).join('')}</section>`).join('')
      : '<div class="empty">No events right now.</div>');
}
function renderGames() {
  return `<div class="hero"><div><h2>🐾 Apex Games</h2><p>Six predator-themed instant games. Every spin is decided on the server. Play money only.</p></div>
      ${me ? '' : '<button class="btn primary" data-act="join">Join &amp; get R1 000 demo credit</button>'}</div>
    <div class="games-grid">${games.map(g => `<button class="gcard" data-game="${g.id}"><img src="${g.image}" alt="${esc(g.name)}" width="256" height="256">
      <div class="gb"><h3>${esc(g.name)}</h3><p>${esc(g.tagline)}</p>
      <div class="chips"><span class="chip ${g.volatility === 'Low' ? 'lo' : g.volatility === 'High' ? 'hi' : ''}">${esc(g.volatility)} volatility</span><span class="chip">RTP ${g.rtp}%</span></div></div></button>`).join('')}</div>`;
}
function renderBets() {
  const open = bets.filter(b => b.status === 'open').length;
  const head = `<div class="hero"><div><h2>My Bets</h2><p>${bets.length ? `${open} open · ${bets.length - open} settled` : 'No bets yet.'}</p></div>
    ${open && me?.demo ? '<button class="btn primary" data-act="settle">Simulate results</button>' : ''}</div>`;
  if (!me) return head + '<div class="empty">Log in to see your bets.</div>';
  return head + bets.map(b => `<article class="bet ${b.status}"><header><span>${b.type === 'multi' ? `Multiple (${b.legs.length})` : 'Single'} · #${b.id}</span><span class="tag ${b.status}">${b.status}</span></header>
    <ul>${b.legs.map(l => `<li>${esc(l.label)} @ ${l.odds.toFixed(2)} – <em>${esc(l.match)}</em>${l.result ? ` (${l.result})` : ''}</li>`).join('')}</ul>
    <div class="sum"><span>Stake ${R(b.stake_cents)} @ ${b.odds.toFixed(2)}</span><strong>${b.status === 'won' ? 'Returned ' + R(b.payout_cents) : b.status === 'lost' ? 'Lost' : 'To return ' + R(Math.floor(b.stake_cents * b.odds))}</strong></div></article>`).join('');
}
function renderSlip() {
  const s = $('#slip'); $('#slipCount').textContent = ui.slip.length;
  s.classList.toggle('open', ui.slipOpen);
  const head = `<div class="slip-h"><h3>Bet Slip (${ui.slip.length})</h3>${ui.slip.length ? '<button data-act="clear" class="btn">Clear</button>' : ''}${ui.slipOpen ? '<button data-act="closeSlip" class="btn" aria-label="Close slip">✕</button>' : ''}</div>`;
  if (!ui.slip.length) { s.innerHTML = head + '<div class="slip-b empty">Your slip is empty.<br>Tap any odds to add a selection.</div>'; return; }
  const multi = ui.mode === 'multi' && ui.slip.length > 1;
  const rows = ui.slip.map(x => { const f = findSel(x.ev, x.mk, x.k); return f ? `<div class="sel-row"><button class="x" data-rm="${x.ev}" aria-label="Remove">×</button>
      <span class="o">${f.s.odds.toFixed(2)}</span><div class="pick">${esc(f.s.label)}</div><div class="m">${esc(f.m.name)} · ${esc(f.e.home)} v ${esc(f.e.away)}</div></div>` : ''; }).join('');
  const stake = stakeCents();
  const total = multi ? stake : stake * ui.slip.length;
  const ret = multi ? Math.floor(stake * Math.round(slipOdds() * 100) / 100) : ui.slip.reduce((a, x) => a + Math.floor(stake * (findSel(x.ev, x.mk, x.k)?.s.odds || 0)), 0);
  s.innerHTML = head + `<div class="slip-b">
    <div class="tabs"><button data-mode="single" class="${!multi ? 'on' : ''}">Singles</button><button data-mode="multi" class="${multi ? 'on' : ''}" ${ui.slip.length < 2 ? 'disabled' : ''}>Multiple</button></div>
    ${rows}
    <label class="field"><span>Stake ${multi ? '' : '(per selection) '}– min R${MIN_STAKE}</span><input id="stake" type="number" inputmode="decimal" min="${MIN_STAKE}" max="${MAX_STAKE}" step="1" value="${esc(ui.stake)}"></label>
    <div class="quick">${[20, 50, 100, 500].map(v => `<button data-q="${v}">R${v}</button>`).join('')}</div>
    ${multi ? `<div class="sum"><span>Total odds</span><strong>${slipOdds().toFixed(2)}</strong></div>` : ''}
    <div class="sum"><span>Total stake</span><strong>${R(total)}</strong></div>
    <div class="sum big"><span>Potential return</span><span>${R(ret)}</span></div>
    <button class="btn primary block" data-act="place" ${ui.busy ? 'disabled' : ''}>${me ? 'Place bet (play money)' : 'Log in to bet'}</button>
    <p class="warn">Demo credit only. 18+. Bet within your means.</p></div>`;
}
const renderAll = () => { renderAcct(); renderSide(); renderContent(); renderSlip(); };

/* ---------- data ---------- */
async function loadEvents() {
  const r = await api('GET', '/events'); if (!r.ok) return;
  const old = {}; events.forEach(e => e.markets.forEach(m => m.sels.forEach(s => (old[`${e.id}|${m.key}|${s.k}`] = s.odds))));
  prevOdds = old; events = r.data.events;
  // drop slip selections whose market no longer exists
  ui.slip = ui.slip.filter(x => findSel(x.ev, x.mk, x.k));
}
async function loadGames() { const r = await api('GET', '/games'); if (r.ok) { games = r.data.games; gameLimits = { min: r.data.min_stake_cents, max: r.data.max_stake_cents }; } }
async function loadBets() { if (!me) { bets = []; return; } const r = await api('GET', '/bets'); if (r.ok) bets = r.data.bets; }

/* ---------- actions ---------- */
function toggleSel(ev, mk, k) {
  const i = ui.slip.findIndex(s => s.ev === ev);
  if (i >= 0 && ui.slip[i].mk === mk && ui.slip[i].k === k) ui.slip.splice(i, 1);
  else if (i >= 0) ui.slip[i] = { ev, mk, k };                      // one selection per match
  else { if (ui.slip.length >= MAX_LEGS) return toast(`Max ${MAX_LEGS} selections`); ui.slip.push({ ev, mk, k }); }
  if (ui.slip.length < 2) ui.mode = 'single';
  renderContent(); renderSlip();
}
async function place() {
  if (!me) return openAuth('login');
  const stake = stakeCents();
  if (stake < MIN_STAKE * 100) return toast(`Minimum stake is R${MIN_STAKE}`);
  if (stake > MAX_STAKE * 100) return toast(`Maximum stake is R${MAX_STAKE}`);
  const multi = ui.mode === 'multi' && ui.slip.length > 1;
  ui.busy = true; renderSlip();
  const r = await api('POST', '/bets', { type: multi ? 'multi' : 'single', stake_cents: stake,
    selections: ui.slip.map(x => ({ ev: x.ev, mk: x.mk, k: x.k, odds: findSel(x.ev, x.mk, x.k).s.odds })) });
  ui.busy = false;
  if (r.ok) { setMe(r.data); ui.slip = []; ui.mode = 'single'; ui.slipOpen = false; await loadBets(); renderAll(); return toast('Bet placed ✔'); }
  if (r.status === 409) { await loadEvents(); renderAll(); return toast('Odds changed – check the new prices and try again'); }
  if (r.status === 401) { setMe(null); renderAll(); return openAuth('login'); }
  renderSlip(); toast(r.data.message || 'Could not place bet');
}

/* ---------- modals ---------- */
const modal = html => { $('#modalCard').innerHTML = html; $('#modal').hidden = false; const i = $('#modalCard input,#modalCard button'); i && i.focus(); };
const closeModal = () => { $('#modal').hidden = true; };
function openAuth(mode) {
  const reg = mode === 'register';
  modal(`<h2>${reg ? 'Join ApexBets' : 'Log in'}</h2>
    ${reg ? '<p class="warn">Demo site: you get R1 000 of play money. A real operator must verify your RSA ID (FICA) before you can bet.</p>' : ''}
    <form id="authForm" data-mode="${mode}">
      <label class="field"><span>Username</span><input name="username" required minlength="3" maxlength="24" autocomplete="username"></label>
      <label class="field"><span>Password${reg ? ' (min 8 characters)' : ''}</span><input name="password" type="password" required minlength="${reg ? 8 : 1}" maxlength="128" autocomplete="${reg ? 'new-password' : 'current-password'}"></label>
      ${reg ? `<label class="field"><span>Date of birth</span><input name="dob" type="date" required></label>
        <label class="check"><input type="checkbox" name="terms" required> I am 18 or older and accept the (demo) terms.</label>` : ''}
      <div class="err" id="authErr" role="alert"></div>
      <button class="btn primary block">${reg ? 'Create account' : 'Log in'}</button></form>
    <button class="btn block mt8" data-act="${reg ? 'login' : 'join'}">${reg ? 'I already have an account' : 'Create an account'}</button>`);
}
function openDeposit() {
  const lim = me.deposit_limit_cents;
  modal(`<h2>Demo deposit</h2><p class="warn">Adds play money only. No real payment is taken.${lim ? ` Daily limit ${R(lim)} – deposited today ${R(me.deposited_today_cents)}.` : ''}</p>
    <div class="quick">${[100, 500, 1000, 2500].map(v => `<button data-dep="${v}">R${v}</button>`).join('')}</div>
    <button class="btn block" data-act="close">Close</button>`);
}
function openLimits() {
  if (!me) return openAuth('login');
  modal(`<h2>Responsible gambling</h2>
    <p class="warn">Set a daily deposit limit. Gambling can be addictive – if you need help call the SA Responsible Gambling Foundation on <strong>0800 006 008</strong>.</p>
    <label class="field"><span>Daily deposit limit (R, 0 = none)</span><input id="lim" type="number" min="0" value="${me.deposit_limit_cents / 100}"></label>
    <button class="btn primary block" data-act="saveLimit">Save limit</button>
    <button class="btn block mt8" data-act="close">Close</button>`);
}
async function openStatement() {
  const r = await api('GET', '/ledger'); if (!r.ok) return toast('Could not load statement');
  const label = { bonus: 'Welcome bonus', deposit: 'Deposit', bet_stake: 'Bet stake', bet_payout: 'Bet winnings', game_stake: 'Game stake', game_win: 'Game win' };
  modal(`<h2>Wallet statement</h2><p class="warn">Balance ${R(me.balance_cents)}. Every movement is recorded in an append-only ledger.</p>
    <table class="stmt">${r.data.entries.map(e => `<tr><td>${new Date(e.created_at).toLocaleString('en-ZA', { dateStyle: 'short', timeStyle: 'short' })}</td><td>${esc(label[e.kind] || e.kind)}${e.ref ? ' ' + esc(e.ref.replace(/^(bet|round):/, '#')) : ''}</td>
      <td class="${e.amount_cents < 0 ? 'neg' : 'pos'}">${e.amount_cents < 0 ? '−' : '+'}${R(Math.abs(e.amount_cents))}</td></tr>`).join('') || '<tr><td>No transactions</td></tr>'}</table>
    <button class="btn block mt8" data-act="close">Close</button>`);
}
async function deposit(rands) {
  const r = await api('POST', '/deposit', { amount_cents: rands * 100 });
  if (r.ok) { setMe(r.data); closeModal(); renderAcct(); renderSlip(); toast(`${R(rands * 100)} demo credit added`); } else toast(r.data.message || 'Deposit failed');
}

/* ---------- games ---------- */
const gs = { id: null, stake: 10, spinning: false };
function openGame(id) {
  const g = games.find(x => x.id === id); if (!g) return;
  gs.id = id; gs.spinning = false;
  modal(`<div class="gm"><img src="${g.image}" alt="${esc(g.name)}"><h2>${esc(g.name)}</h2>
    <p class="warn">${esc(g.tagline)} · RTP ${g.rtp}% · ${esc(g.volatility)} volatility</p>
    <div class="reels" aria-live="polite"><div class="reel" id="r0">${g.animal}</div><div class="reel" id="r1">${g.animal}</div><div class="reel" id="r2">${g.animal}</div></div>
    <div class="gresult" id="gres">Place your stake and spin</div>
    <div class="quick" id="gq">${[5, 10, 50, 100].map(v => `<button data-gstake="${v}" class="${gs.stake === v ? 'on' : ''}">R${v}</button>`).join('')}</div>
    <button class="btn primary block" data-act="spin" id="gspin">${me ? `Spin – R${gs.stake}` : 'Log in to play'}</button>
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
  if ($('#modal').hidden || gs.id !== g.id || !$('#r0')) return;      // modal closed mid-spin
  reels.forEach(x => x.classList.remove('spin')); $('#gspin').disabled = false;
  if (!r.ok) { reels.forEach((x, i) => (x.textContent = g.animal)); $('#gres').textContent = r.data.message || 'Could not play'; if (r.status === 401) { setMe(null); renderAll(); } return; }
  r.data.reels.forEach((sym, i) => (reels[i].textContent = g.symbols[sym]));
  setMe(r.data); renderAcct();
  const res = $('#gres');
  res.textContent = !r.data.payout_cents ? 'No win – try again' : r.data.mult <= 1 ? `Stake returned ${R(r.data.payout_cents)}` : `Win ${R(r.data.payout_cents)} (${r.data.mult}×)`;
  res.className = 'gresult' + (r.data.mult > 1 ? ' win' : '');
}

/* ---------- events ---------- */
document.addEventListener('click', async e => {
  const t = e.target.closest('button'); if (!t) { if (e.target.id === 'modal') closeModal(); return; }
  const d = t.dataset;
  if (d.ev && d.mk) return toggleSel(d.ev, d.mk, d.k);
  if (d.rm) { ui.slip = ui.slip.filter(s => s.ev !== d.rm); if (ui.slip.length < 2) ui.mode = 'single'; renderContent(); return renderSlip(); }
  if (d.sport) { ui.sport = d.sport; ui.view = 'sports'; setNav(); renderSide(); return renderContent(); }
  if (d.view) return goView(d.view);
  if (d.mode) { ui.mode = d.mode; return renderSlip(); }
  if (d.q) { ui.stake = Number(d.q); return renderSlip(); }
  if (d.dep) return deposit(Number(d.dep));
  if (d.game) return openGame(d.game);
  if (d.gstake) { gs.stake = Number(d.gstake); document.querySelectorAll('#gq button').forEach(b => b.classList.toggle('on', b.dataset.gstake === d.gstake)); const sp = $('#gspin'); if (sp && me) sp.textContent = `Spin – R${gs.stake}`; return; }
  switch (d.act) {
    case 'join': return openAuth('register');
    case 'login': return openAuth('login');
    case 'deposit': return me && openDeposit();
    case 'limits': return openLimits();
    case 'statement': return openStatement();
    case 'saveLimit': { const r = await api('PUT', '/limits', { deposit_limit_cents: Math.round((Number($('#lim').value) || 0) * 100) }); if (r.ok) { setMe(r.data); closeModal(); toast('Limit saved'); } else toast(r.data.message || 'Could not save'); return; }
    case 'logout': await api('POST', '/logout'); me = null; bets = []; renderAll(); return;
    case 'clear': ui.slip = []; ui.mode = 'single'; renderContent(); return renderSlip();
    case 'place': return place();
    case 'spin': return spin();
    case 'settle': { const r = await api('POST', '/bets/settle-demo'); if (r.ok) { setMe(r.data); await loadBets(); renderAll(); toast(r.data.won ? `${r.data.won} winning bet${r.data.won > 1 ? 's' : ''}!` : 'Results in – no winners this time'); } return; }
    case 'close': return closeModal();
    case 'closeSlip': ui.slipOpen = false; return renderSlip();
  }
});
$('#slipFab').addEventListener('click', () => { ui.slipOpen = true; renderSlip(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
document.addEventListener('input', e => {
  if (e.target.id !== 'stake') return;
  ui.stake = e.target.value; const pos = e.target.selectionStart;
  renderSlip(); const n = $('#stake'); n.focus(); try { n.setSelectionRange(pos, pos); } catch (_) {}
});
document.addEventListener('submit', async e => {
  if (e.target.id !== 'authForm') return; e.preventDefault();
  const f = new FormData(e.target), reg = e.target.dataset.mode === 'register';
  const body = { username: f.get('username').trim(), password: f.get('password') };
  if (reg) { body.dob = f.get('dob'); body.terms = f.get('terms') === 'on'; }
  const btn = e.target.querySelector('button'); btn.disabled = true;
  const r = await api('POST', reg ? '/register' : '/login', body);
  if (!r.ok) { btn.disabled = false; $('#authErr').textContent = r.data.message || 'Something went wrong'; return; }
  setMe(r.data); await loadBets(); closeModal(); renderAll(); toast(`Welcome, ${me.user.username}!`);
});
function setNav() { document.querySelectorAll('#mainNav button').forEach(b => b.classList.toggle('active', b.dataset.view === ui.view)); }
async function goView(v) { ui.view = v; setNav(); if (v === 'mybets') await loadBets(); renderSide(); renderContent(); }
$('#mainNav').addEventListener('click', e => { const b = e.target.closest('button'); if (b) goView(b.dataset.view); });

/* ---------- boot ---------- */
(async () => {
  const [m] = await Promise.all([api('GET', '/me'), loadEvents(), loadGames()]);
  setMe(m.data); renderAll();
  setInterval(async () => {
    if (document.hidden) return;
    await loadEvents();
    if (document.activeElement && document.activeElement.id === 'stake') return;   // don't clobber typing
    renderContent(); renderSlip();
  }, 5000);
})();
})();
