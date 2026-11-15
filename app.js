/* BreezyBets – demo sportsbook. Play money only; all data is sample data stored in the browser. */
(() => {
'use strict';

const MARGIN = 0.06;             // bookmaker margin baked into odds
const MIN_STAKE = 5, MAX_STAKE = 5000, MAX_LEGS = 12;
const STORE_KEY = 'breezybets_demo_v1';
const $ = (s, r = document) => r.querySelector(s);
const R = n => 'R' + n.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const oddsFrom = p => Math.max(1.01, Math.round(100 / (p * (1 + MARGIN))) / 100);

/* ---------- sample fixtures ---------- */
const SPORTS = [
  { id: 'soccer', name: 'Soccer', icon: '⚽' },
  { id: 'rugby', name: 'Rugby', icon: '🏉' },
  { id: 'cricket', name: 'Cricket', icon: '🏏' },
  { id: 'tennis', name: 'Tennis', icon: '🎾' },
  { id: 'basketball', name: 'Basketball', icon: '🏀' },
];
// [sport, league, home, away, hoursFromNow, probs(home,draw,away) – draw null if none, live]
const RAW = [
  ['soccer', 'South Africa – Premiership (PSL)', 'Kaizer Chiefs', 'Orlando Pirates', -0.6, [.30, .28, .42], true],
  ['soccer', 'South Africa – Premiership (PSL)', 'Mamelodi Sundowns', 'Stellenbosch FC', 3, [.62, .22, .16]],
  ['soccer', 'South Africa – Premiership (PSL)', 'SuperSport United', 'Cape Town City', 5, [.38, .30, .32]],
  ['soccer', 'South Africa – Premiership (PSL)', 'AmaZulu', 'Royal AM', 27, [.45, .28, .27]],
  ['soccer', 'South Africa – Premiership (PSL)', 'Sekhukhune United', 'Richards Bay', 29, [.44, .29, .27]],
  ['soccer', 'England – Premier League', 'Arsenal', 'Liverpool', 7, [.42, .27, .31]],
  ['soccer', 'England – Premier League', 'Manchester City', 'Chelsea', 8, [.58, .23, .19]],
  ['soccer', 'Spain – La Liga', 'Real Madrid', 'FC Barcelona', 30, [.40, .25, .35]],
  ['rugby', 'United Rugby Championship', 'Stormers', 'Leinster', -0.4, [.38, null, .62], true],
  ['rugby', 'United Rugby Championship', 'Bulls', 'Munster', 4, [.60, null, .40]],
  ['rugby', 'United Rugby Championship', 'Sharks', 'Glasgow Warriors', 28, [.55, null, .45]],
  ['rugby', 'Rugby Championship', 'South Africa', 'New Zealand', 52, [.48, null, .52]],
  ['cricket', 'SA20', 'MI Cape Town', 'Joburg Super Kings', 6, [.50, null, .50]],
  ['cricket', 'SA20', 'Pretoria Capitals', 'Paarl Royals', 30, [.47, null, .53]],
  ['cricket', 'SA20', 'Sunrisers Eastern Cape', 'Durban’s Super Giants', 54, [.58, null, .42]],
  ['tennis', 'ATP Tour', 'Carlos Alcaraz', 'Jannik Sinner', 9, [.49, null, .51]],
  ['tennis', 'WTA Tour', 'Iga Świątek', 'Aryna Sabalenka', 10, [.52, null, .48]],
  ['basketball', 'NBA', 'Boston Celtics', 'Denver Nuggets', 11, [.55, null, .45]],
  ['basketball', 'NBA', 'LA Lakers', 'Golden State Warriors', 12, [.46, null, .54]],
];
const NOW = Date.now();
const events = RAW.map((r, i) => {
  const [sport, league, home, away, h, p, live] = r;
  const e = { id: 'e' + i, sport, league, home, away, start: NOW + h * 36e5, live: !!live, p: p.slice(), prev: {},
    score: live ? [sport === 'rugby' ? 14 : 1, sport === 'rugby' ? 17 : 1] : null, minute: live ? (sport === 'rugby' ? 52 : 63) : 0 };
  if (sport === 'soccer') e.ou = 0.52; // P(over 2.5)
  return e;
});
function markets(e) {
  const hasDraw = e.p[1] != null;
  const m = [{ key: 'w', name: hasDraw ? 'Match Result' : 'Match Winner', sels: [
    { k: 'h', label: e.home, short: '1', odds: oddsFrom(e.p[0]) },
    ...(hasDraw ? [{ k: 'd', label: 'Draw', short: 'X', odds: oddsFrom(e.p[1]) }] : []),
    { k: 'a', label: e.away, short: hasDraw ? '2' : '2', odds: oddsFrom(e.p[2]) }] }];
  if (e.sport === 'soccer') m.push({ key: 'ou', name: 'Total Goals 2.5', sels: [
    { k: 'o', label: 'Over 2.5', short: 'O', odds: oddsFrom(e.ou) },
    { k: 'u', label: 'Under 2.5', short: 'U', odds: oddsFrom(1 - e.ou) }] });
  return m;
}
const findSel = (evId, mk, k) => {
  const e = events.find(x => x.id === evId); if (!e) return null;
  const m = markets(e).find(x => x.key === mk); const s = m && m.sels.find(x => x.k === k);
  return s ? { e, m, s } : null;
};

/* ---------- state ---------- */
let st = { user: null, balance: 0, bets: [], nextId: 1, depositLimit: 0, deposited: { day: '', amt: 0 } };
try { Object.assign(st, JSON.parse(localStorage.getItem(STORE_KEY)) || {}); } catch (_) {}
const save = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(st)); } catch (_) {} };
const ui = { view: 'sports', sport: 'soccer', slip: [], mode: 'single', stake: 50, slipOpen: false };
const today = () => new Date().toISOString().slice(0, 10);

/* ---------- helpers ---------- */
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2600); }
const fmtTime = ms => new Date(ms).toLocaleString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Johannesburg' }) + ' SAST';
const inSlip = (id, mk, k) => ui.slip.some(s => s.ev === id && s.mk === mk && s.k === k);
function slipOdds() { return ui.slip.reduce((a, s) => a * (findSel(s.ev, s.mk, s.k)?.s.odds || 1), 1); }

/* ---------- render ---------- */
function renderAcct() {
  $('#acct').innerHTML = st.user
    ? `<span class="bal" title="Play money">${R(st.balance)}</span>
       <button class="btn primary" data-act="deposit">Deposit</button>
       <button class="btn" data-act="logout" title="Log out ${esc(st.user)}">Log out</button>`
    : `<button class="btn" data-act="join">Log in</button><button class="btn primary" data-act="join">Join now</button>`;
}
function renderSide() {
  const live = events.filter(e => e.live).length;
  $('#side').innerHTML = '<h3>Sports</h3>' + SPORTS.map(s => {
    const n = events.filter(e => e.sport === s.id).length;
    return `<button data-sport="${s.id}" class="${ui.sport === s.id && ui.view !== 'mybets' ? 'active' : ''}"><span>${s.icon} ${s.name}</span><span class="n">${n}</span></button>`;
  }).join('') + `<h3>Quick links</h3><button data-act="limits"><span>🛡️ Responsible gambling</span></button>`;
  void live;
}
function oddBtn(e, m, s) {
  const key = e.id + m.key + s.k, prev = e.prev[key];
  const cls = (inSlip(e.id, m.key, s.k) ? ' sel' : '') + (prev && prev !== s.odds ? (s.odds > prev ? ' up' : ' down') : '');
  return `<button class="odd${cls}" data-ev="${e.id}" data-mk="${m.key}" data-k="${s.k}" aria-pressed="${inSlip(e.id, m.key, s.k)}" aria-label="${esc(s.label)} at ${s.odds.toFixed(2)}"><small>${esc(s.short)}</small><b>${s.odds.toFixed(2)}</b></button>`;
}
function evCard(e) {
  const ms = markets(e);
  const sc = e.score;
  return `<div class="ev"><div>
      <div class="meta">${e.live ? `<span class="live">● LIVE ${e.minute}'</span>` : fmtTime(e.start)}</div>
      <div class="team"><span>${esc(e.home)}</span><span class="sc">${sc ? sc[0] : ''}</span></div>
      <div class="team"><span>${esc(e.away)}</span><span class="sc">${sc ? sc[1] : ''}</span></div>
    </div><div>${ms.map(m => `<div class="odds" ${m.key !== 'w' ? 'style="margin-top:6px"' : ''}>${m.sels.map(s => oddBtn(e, m, s)).join('')}</div>`).join('')}</div></div>`;
}
function renderContent() {
  const c = $('#content');
  if (ui.view === 'mybets') return (c.innerHTML = renderBets());
  let list = ui.view === 'live' ? events.filter(e => e.live) : events.filter(e => e.sport === ui.sport);
  const sp = SPORTS.find(s => s.id === ui.sport);
  const byLeague = {};
  list.sort((a, b) => b.live - a.live || a.start - b.start).forEach(e => (byLeague[e.league] ||= []).push(e));
  const title = ui.view === 'live' ? 'Live now' : `${sp.icon} ${sp.name}`;
  c.innerHTML = `<div class="hero"><div><h2>${title}</h2><p>${ui.view === 'live' ? 'Odds and scores update automatically (simulated).' : 'Sample fixtures with simulated odds. Pick a price to add it to your bet slip.'}</p></div>
      ${st.user ? '' : '<button class="btn primary" data-act="join">Join &amp; get R1 000 demo credit</button>'}</div>` +
    (Object.keys(byLeague).length ? Object.entries(byLeague).map(([lg, evs]) =>
      `<section class="league"><h3><span>${esc(lg)}</span><span>${evs.length}</span></h3>${evs.map(evCard).join('')}</section>`).join('')
      : '<div class="empty">No live events right now.</div>');
}
function renderBets() {
  const open = st.bets.filter(b => b.status === 'open').length;
  const head = `<div class="hero"><div><h2>My Bets</h2><p>${st.bets.length ? `${open} open · ${st.bets.length - open} settled` : 'No bets yet.'}</p></div>
    ${open ? '<button class="btn primary" data-act="settle">Simulate results</button>' : ''}</div>`;
  if (!st.user) return head + '<div class="empty">Log in to see your bets.</div>';
  return head + [...st.bets].reverse().map(b => `<article class="bet ${b.status}"><header><span>${b.type === 'multi' ? `Multiple (${b.legs.length})` : 'Single'} · #${b.id}</span><span class="tag ${b.status}">${b.status}</span></header>
    <ul>${b.legs.map(l => `<li>${esc(l.pick)} @ ${l.odds.toFixed(2)} – <em>${esc(l.match)}</em>${l.res ? ` (${l.res})` : ''}</li>`).join('')}</ul>
    <div class="sum"><span>Stake ${R(b.stake)} @ ${b.odds.toFixed(2)}</span><strong>${b.status === 'won' ? 'Returned ' + R(b.ret) : b.status === 'lost' ? 'Lost' : 'To return ' + R(b.stake * b.odds)}</strong></div></article>`).join('');
}
function renderSlip() {
  const s = $('#slip'); $('#slipCount').textContent = ui.slip.length;
  s.classList.toggle('open', ui.slipOpen);
  const head = `<div class="slip-h"><h3>Bet Slip (${ui.slip.length})</h3>${ui.slip.length ? '<button data-act="clear" class="btn">Clear</button>' : ''}${ui.slipOpen ? '<button data-act="closeSlip" class="btn" aria-label="Close slip">✕</button>' : ''}</div>`;
  if (!ui.slip.length) { s.innerHTML = head + '<div class="slip-b empty">Your slip is empty.<br>Tap any odds to add a selection.</div>'; return; }
  const multi = ui.mode === 'multi' && ui.slip.length > 1;
  const rows = ui.slip.map(x => { const f = findSel(x.ev, x.mk, x.k); return f ? `<div class="sel-row"><button class="x" data-rm="${x.ev}" aria-label="Remove">×</button>
      <span class="o">${f.s.odds.toFixed(2)}</span><div class="pick">${esc(f.s.label)}</div><div class="m">${esc(f.m.name)} · ${esc(f.e.home)} v ${esc(f.e.away)}</div></div>` : ''; }).join('');
  const stake = Number(ui.stake) || 0;
  const n = multi ? 1 : ui.slip.length;
  const totalStake = stake * n;
  const ret = multi ? stake * slipOdds() : ui.slip.reduce((a, x) => a + stake * findSel(x.ev, x.mk, x.k).s.odds, 0);
  s.innerHTML = head + `<div class="slip-b">
    <div class="tabs"><button data-mode="single" class="${!multi ? 'on' : ''}">Singles</button><button data-mode="multi" class="${multi ? 'on' : ''}" ${ui.slip.length < 2 ? 'disabled' : ''}>Multiple</button></div>
    ${rows}
    <label class="field"><span>Stake ${multi ? '' : '(per selection)'} – min ${R(MIN_STAKE)}</span><input id="stake" type="number" inputmode="decimal" min="${MIN_STAKE}" max="${MAX_STAKE}" step="1" value="${ui.stake}"></label>
    <div class="quick">${[20, 50, 100, 500].map(v => `<button data-q="${v}">R${v}</button>`).join('')}</div>
    ${multi ? `<div class="sum"><span>Total odds</span><strong>${slipOdds().toFixed(2)}</strong></div>` : ''}
    <div class="sum"><span>Total stake</span><strong>${R(totalStake)}</strong></div>
    <div class="sum big"><span>Potential return</span><span>${R(ret)}</span></div>
    <button class="btn primary block" data-act="place">${st.user ? 'Place bet (play money)' : 'Log in to bet'}</button>
    <p class="warn">Demo credit only. 18+. Bet within your means.</p></div>`;
}
const renderAll = () => { renderAcct(); renderSide(); renderContent(); renderSlip(); };

/* ---------- actions ---------- */
function toggleSel(ev, mk, k) {
  const i = ui.slip.findIndex(s => s.ev === ev);
  if (i >= 0 && ui.slip[i].mk === mk && ui.slip[i].k === k) ui.slip.splice(i, 1);
  else if (i >= 0 && ui.slip[i].mk === mk) ui.slip[i].k = k;
  else if (i >= 0 && ui.slip.some(s => s.ev === ev)) { // different market, same event – not allowed in a multiple
    if (ui.mode === 'multi') toast('Only one selection per match in a multiple'); ui.slip[i] = { ev, mk, k };
  } else { if (ui.slip.length >= MAX_LEGS) return toast(`Max ${MAX_LEGS} selections`); ui.slip.push({ ev, mk, k }); }
  if (ui.slip.length < 2) ui.mode = 'single';
  renderContent(); renderSlip();
}
function place() {
  if (!st.user) return openJoin();
  const stake = Number(ui.stake);
  if (!(stake >= MIN_STAKE)) return toast(`Minimum stake is ${R(MIN_STAKE)}`);
  if (stake > MAX_STAKE) return toast(`Maximum stake is ${R(MAX_STAKE)}`);
  const multi = ui.mode === 'multi' && ui.slip.length > 1;
  const total = multi ? stake : stake * ui.slip.length;
  if (total > st.balance) return toast('Insufficient balance – make a demo deposit');
  const legs = ui.slip.map(x => { const f = findSel(x.ev, x.mk, x.k); return { ev: x.ev, mk: x.mk, k: x.k, pick: f.s.label, odds: f.s.odds, match: `${f.e.home} v ${f.e.away}` }; });
  const mk = (ls, stk) => ({ id: st.nextId++, type: ls.length > 1 ? 'multi' : 'single', legs: ls, stake: stk, odds: ls.reduce((a, l) => a * l.odds, 1), status: 'open', ts: Date.now() });
  (multi ? [mk(legs, stake)] : legs.map(l => mk([l], stake))).forEach(b => st.bets.push(b));
  st.balance = Math.round((st.balance - total) * 100) / 100;
  ui.slip = []; ui.mode = 'single'; ui.slipOpen = false; save(); renderAll(); toast('Bet placed ✔');
}
function settle() {
  let won = 0;
  st.bets.filter(b => b.status === 'open').forEach(b => {
    b.legs.forEach(l => { l.res = Math.random() < 1 / l.odds ? 'won' : 'lost'; });
    if (b.legs.every(l => l.res === 'won')) { b.status = 'won'; b.ret = Math.round(b.stake * b.odds * 100) / 100; st.balance += b.ret; won++; } else b.status = 'lost';
  });
  st.balance = Math.round(st.balance * 100) / 100; save(); renderAll(); toast(won ? `${won} winning bet${won > 1 ? 's' : ''}!` : 'Results in – no winners this time');
}

/* ---------- modals ---------- */
const modal = html => { $('#modalCard').innerHTML = html; $('#modal').hidden = false; const i = $('#modalCard input,#modalCard button'); i && i.focus(); };
const closeModal = () => { $('#modal').hidden = true; };
function openJoin() {
  modal(`<h2>Join BreezyBets</h2><p class="warn">Demo registration – nothing is verified or sent anywhere. A real site needs FICA/KYC with a RSA ID check.</p>
    <form id="joinForm"><label class="field"><span>Username</span><input name="u" required maxlength="24" autocomplete="off"></label>
    <label class="field"><span>Date of birth</span><input name="dob" type="date" required></label>
    <label class="check"><input type="checkbox" name="t" required> I am 18 or older and accept the (demo) terms.</label>
    <div class="err" id="joinErr"></div>
    <button class="btn primary block">Create account &amp; get R1 000 demo credit</button></form>
    <button class="btn block" data-act="close" style="margin-top:8px">Cancel</button>`);
}
function openDeposit() {
  modal(`<h2>Demo deposit</h2><p class="warn">Adds play money only. No real payment is taken.${st.depositLimit ? ` Your daily limit: ${R(st.depositLimit)}.` : ''}</p>
    <div class="quick">${[100, 500, 1000, 2500].map(v => `<button data-dep="${v}">R${v}</button>`).join('')}</div>
    <button class="btn block" data-act="close">Close</button>`);
}
function openLimits() {
  modal(`<h2>Responsible gambling</h2>
    <p class="warn">Set a daily deposit limit. Gambling can be addictive – if you need help, call the SA Responsible Gambling Foundation on <strong>0800 006 008</strong>.</p>
    <label class="field"><span>Daily deposit limit (R, 0 = none)</span><input id="lim" type="number" min="0" value="${st.depositLimit || 0}"></label>
    <button class="btn primary block" data-act="saveLimit">Save limit</button>
    <button class="btn block" data-act="close" style="margin-top:8px">Close</button>`);
}
function deposit(v) {
  if (!st.user) return;
  if (st.deposited.day !== today()) st.deposited = { day: today(), amt: 0 };
  if (st.depositLimit && st.deposited.amt + v > st.depositLimit) return toast(`Over your daily limit (${R(st.depositLimit)})`);
  st.deposited.amt += v; st.balance += v; save(); closeModal(); renderAcct(); renderSlip(); toast(`${R(v)} demo credit added`);
}

/* ---------- events ---------- */
document.addEventListener('click', e => {
  const t = e.target.closest('button,[data-ev]'); if (!t) { if (e.target.id === 'modal') closeModal(); return; }
  const d = t.dataset;
  if (d.ev && d.mk) return toggleSel(d.ev, d.mk, d.k);
  if (d.rm) { ui.slip = ui.slip.filter(s => s.ev !== d.rm); if (ui.slip.length < 2) ui.mode = 'single'; renderContent(); return renderSlip(); }
  if (d.sport) { ui.sport = d.sport; ui.view = 'sports'; setNav(); renderSide(); return renderContent(); }
  if (d.view) { ui.view = d.view; setNav(); renderSide(); return renderContent(); }
  if (d.mode) { ui.mode = d.mode; return renderSlip(); }
  if (d.q) { ui.stake = Number(d.q); return renderSlip(); }
  if (d.dep) return deposit(Number(d.dep));
  switch (d.act) {
    case 'join': return openJoin();
    case 'deposit': return st.user && openDeposit();
    case 'limits': return openLimits();
    case 'saveLimit': st.depositLimit = Math.max(0, Number($('#lim').value) || 0); save(); closeModal(); return toast('Limit saved');
    case 'logout': st.user = null; save(); return renderAll();
    case 'clear': ui.slip = []; ui.mode = 'single'; renderContent(); return renderSlip();
    case 'place': return place();
    case 'settle': return settle();
    case 'close': return closeModal();
    case 'closeSlip': ui.slipOpen = false; return renderSlip();
  }
});
$('#slipFab').addEventListener('click', () => { ui.slipOpen = true; renderSlip(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
document.addEventListener('input', e => { if (e.target.id === 'stake') { ui.stake = e.target.value; renderSlipTotalsOnly(); } });
function renderSlipTotalsOnly() { // keep input focus while typing
  const f = $('#stake'); const pos = f.selectionStart; renderSlip(); const n = $('#stake'); n.focus(); try { n.setSelectionRange(pos, pos); } catch (_) {}
}
document.addEventListener('submit', e => {
  if (e.target.id !== 'joinForm') return; e.preventDefault();
  const f = new FormData(e.target), dob = new Date(f.get('dob')), now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  if (now < new Date(now.getFullYear(), dob.getMonth(), dob.getDate())) age--;
  if (isNaN(age) || age < 18) return ($('#joinErr').textContent = 'You must be 18 or older to join.');
  if (age > 120) return ($('#joinErr').textContent = 'Please enter a valid date of birth.');
  st.user = String(f.get('u')).trim().slice(0, 24); if (!st.bets.length && !st.balance) st.balance = 1000;
  save(); closeModal(); renderAll(); toast(`Welcome, ${st.user}!`);
});
function setNav() { document.querySelectorAll('#mainNav button').forEach(b => b.classList.toggle('active', b.dataset.view === (ui.view === 'mybets' ? 'mybets' : ui.view === 'live' ? 'live' : 'sports'))); }
$('#mainNav').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { ui.view = b.dataset.view; setNav(); renderSide(); renderContent(); } });

/* ---------- live simulation ---------- */
setInterval(() => {
  events.filter(e => e.live).forEach(e => {
    e.minute = Math.min(e.minute + 1, e.sport === 'rugby' ? 80 : 90);
    if (Math.random() < .08 && e.score) { const side = Math.random() < .5 ? 0 : 1; e.score[side] += e.sport === 'rugby' ? (Math.random() < .5 ? 7 : 3) : 1; }
  });
  [...events].forEach(e => {
    const m = markets(e); m.forEach(mm => mm.sels.forEach(s => (e.prev[e.id + mm.key + s.k] = s.odds)));
    const j = e.live ? .03 : .008;
    const sh = (Math.random() - .5) * j; e.p[0] = Math.min(.9, Math.max(.05, e.p[0] + sh));
    if (e.p[1] != null) { e.p[1] = Math.min(.5, Math.max(.08, e.p[1] - sh / 2)); e.p[2] = Math.max(.05, 1 - e.p[0] - e.p[1]); }
    else e.p[2] = 1 - e.p[0];
    if (e.ou != null) e.ou = Math.min(.8, Math.max(.2, e.ou + (Math.random() - .5) * j));
  });
  if (document.activeElement && document.activeElement.id === 'stake') return; // don't clobber typing
  renderContent(); renderSlip();
}, 5000);

renderAll();
})();
