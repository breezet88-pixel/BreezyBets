import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { resolve, extname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, tx } from './db.js';
import { createOddsEngine, winProbability } from './odds.js';
import { WalletError, balance, userAccount, credit, debit, post, depositedToday } from './wallet.js';
import { GAMES, gameById, publicGame, spin, evaluate } from './games.js';
import { hashPassword, verifyPassword, createSession, userForToken, destroySession, ageFromDob, createLimiter, SESSION_TTL_MS } from './auth.js';
import { HttpError, bad } from './errors.js';
import { BREAK_HOURS, settleLimit, changeLimit, onBreak, startBreak, statement, currentMonth, isMonth } from './safety.js';

const PUBLIC_DIR = resolve(fileURLToPath(new URL('../public', import.meta.url)));
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const COOKIE = 'ab_session';
const MIN_STAKE = 500, MAX_STAKE = 500000, MAX_LEGS = 12;          // cents
const MIN_GAME_STAKE = 100, MAX_GAME_STAKE = 50000;                // R1 – R500 per round
const MIN_DEPOSIT = 1000, MAX_DEPOSIT = 500000, WELCOME_BONUS = 100000;

const MAX_LIMIT = 100000000;                                       // R1 million: a sanity cap on a daily deposit limit
// A daily deposit limit is either 0 (the player chose "no limit") or at least one minimum deposit.
const validLimit = v => Number.isInteger(v) && (v === 0 || (v >= MIN_DEPOSIT && v <= MAX_LIMIT));

export function createApp({ dbPath = process.env.DB_PATH || './data/apexbets.db', demoMode = process.env.DEMO_MODE !== 'false', gamesEnabled = process.env.GAMES_ENABLED ? process.env.GAMES_ENABLED === 'true' : demoMode, secureCookies = process.env.NODE_ENV === 'production', simulate = true, signupsPerHour = 10,
  limitCoolOffMs = Number(process.env.LIMIT_COOLOFF_HOURS ?? 24) * 36e5 } = {}) {
  const db = openDb(dbPath);
  const odds = createOddsEngine();
  const loginLimiter = createLimiter(5, 15 * 60e3), signupLimiter = createLimiter(signupsPerHour, 60 * 60e3);
  const ticker = simulate ? setInterval(() => odds.tick(), 5000) : null;
  ticker?.unref();

  const me = u => ({
    user: { id: u.id, username: u.username },
    balance_cents: balance(db, userAccount(u.id)),
    deposit_limit_cents: u.deposit_limit_cents,
    deposited_today_cents: depositedToday(db, u.id),
    pending_limit: u.deposit_limit_pending_at ? { cents: u.deposit_limit_pending_cents, at: u.deposit_limit_pending_at } : null,
    break_until: onBreak(u) ? u.break_until : null,
    demo: demoMode,
  });
  const cookieHeader = (token, maxAge) =>
    `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secureCookies ? '; Secure' : ''}`;
  const money = (v, min, max, what) => {
    if (!Number.isInteger(v) || v < min || v > max) throw bad(`${what} must be between R${min / 100} and R${max / 100}`, 'bad_amount');
    return v;
  };

  /* ---- route handlers: (ctx) => [status, body, headers?] ---- */
  const routes = {
    'POST /api/register': async ({ body, ip }) => {
      if (signupLimiter.blocked(ip)) throw new HttpError(429, 'rate_limited', 'Too many sign-ups, try later');
      signupLimiter.fail(ip);
      const { username, password, dob, terms, deposit_limit_cents: limit } = body;
      if (!/^[A-Za-z0-9_]{3,24}$/.test(username || '')) throw bad('Username must be 3–24 letters, numbers or underscores');
      if (typeof password !== 'string' || password.length < 8 || password.length > 128) throw bad('Password must be 8–128 characters');
      const age = ageFromDob(dob); if (age === null || age > 120) throw bad('Enter a valid date of birth');
      if (age < 18) throw new HttpError(403, 'underage', 'You must be 18 or older to join');
      if (terms !== true) throw bad('You must accept the terms');
      // Every new player makes an explicit choice, including the choice of no limit.
      if (!validLimit(limit)) throw bad('Choose your daily deposit limit', 'limit_required');
      const pass_hash = await hashPassword(password);
      let user;
      try {
        user = tx(db, () => {
          const { lastInsertRowid } = db.prepare('INSERT INTO users (username,pass_hash,dob,deposit_limit_cents,created_at) VALUES (?,?,?,?,?)').run(username, pass_hash, dob, limit, Date.now());
          const id = Number(lastInsertRowid);
          if (demoMode) credit(db, id, 'bonus', 'house:demo_bonus', WELCOME_BONUS, 'welcome');   // play money; real-money mode never creates money
          return db.prepare('SELECT * FROM users WHERE id=?').get(id);
        });
      } catch (e) { if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'username_taken', 'Username already taken'); throw e; }
      return [201, me(user), { 'Set-Cookie': cookieHeader(createSession(db, user.id), SESSION_TTL_MS / 1000) }];
    },

    'POST /api/login': async ({ body, ip }) => {
      const key = `${ip}|${String(body.username).toLowerCase()}`;
      if (loginLimiter.blocked(key)) throw new HttpError(429, 'rate_limited', 'Too many failed attempts, try again in 15 minutes');
      const u = typeof body.username === 'string' && db.prepare('SELECT * FROM users WHERE username=?').get(body.username);
      // Verify against a dummy hash for unknown users to keep timing similar.
      const ok = typeof body.password === 'string' && await verifyPassword(body.password, u ? u.pass_hash : DUMMY_HASH);
      if (!u || !ok) { loginLimiter.fail(key); throw new HttpError(401, 'bad_credentials', 'Invalid username or password'); }
      loginLimiter.reset(key);
      return [200, me(u), { 'Set-Cookie': cookieHeader(createSession(db, u.id), SESSION_TTL_MS / 1000) }];
    },

    'POST /api/logout': ({ token }) => { if (token) destroySession(db, token); return [200, { ok: true }, { 'Set-Cookie': cookieHeader('', 0) }]; },
    'GET /api/me': ({ user }) => [200, user ? me(user) : { user: null }],
    'GET /api/config': () => [200, { demo: demoMode, games: gamesEnabled, break_hours: BREAK_HOURS, limit_cooloff_hours: limitCoolOffMs / 36e5, min_deposit_cents: MIN_DEPOSIT }],
    'GET /api/events': () => [200, { events: odds.snapshot() }],

    'POST /api/deposit': ({ user, body }) => {
      needActive(user);
      if (!demoMode) throw new HttpError(501, 'no_payment_provider', 'No payment provider configured');
      const amt = money(body.amount_cents, MIN_DEPOSIT, MAX_DEPOSIT, 'Deposit');
      return [200, tx(db, () => {
        const lim = user.deposit_limit_cents;
        if (lim && depositedToday(db, user.id) + amt > lim) throw new HttpError(422, 'deposit_limit', 'This deposit would exceed your daily deposit limit');
        credit(db, user.id, 'deposit', 'house:demo_funding', amt, null); // real build: only after payment provider confirms
        return me(user);
      })];
    },

    // Lowering a limit applies at once. Raising or removing it waits out the cooling-off period.
    'PUT /api/limits': ({ user, body }) => {
      need(user);
      const v = body.deposit_limit_cents;
      if (!validLimit(v)) throw bad(`A daily limit must be at least R${MIN_DEPOSIT / 100}, or 0 for no limit`, 'bad_limit');
      return [200, me(changeLimit(db, user, v, limitCoolOffMs))];
    },

    // A break pauses deposits, bets and games. It can be extended, never shortened. Withdrawals still work.
    'POST /api/break': ({ user, body }) => {
      need(user);
      if (!BREAK_HOURS.includes(body.hours)) throw bad('Choose a break of 24 hours, 7 days or 30 days', 'bad_break');
      return [200, me(startBreak(db, user, body.hours))];
    },

    // The plain monthly statement: money in, money out, result of play.
    'GET /api/statement': ({ user, query }) => {
      need(user);
      const month = query.get('month') || currentMonth();
      if (!isMonth(month)) throw bad('month must look like 2026-11', 'bad_month');
      return [200, statement(db, user.id, month)];
    },

    'POST /api/bets': ({ user, body }) => {
      needActive(user);
      const sels = body.selections;
      if (!Array.isArray(sels) || !sels.length || sels.length > MAX_LEGS) throw bad(`Choose 1–${MAX_LEGS} selections`);
      if (!['single', 'multi'].includes(body.type)) throw bad('type must be single or multi');
      if (body.type === 'multi' && sels.length < 2) throw bad('A multiple needs at least 2 selections');
      if (new Set(sels.map(s => s.ev)).size !== sels.length) throw bad('Only one selection per match', 'duplicate_event');
      const stake = money(body.stake_cents, MIN_STAKE, MAX_STAKE, 'Stake');

      const legs = [], changed = [];
      for (const s of sels) {
        const f = odds.lookup(s.ev, s.mk, s.k);
        if (!f) throw new HttpError(422, 'market_closed', 'A selection is no longer available');
        if (typeof s.odds !== 'number' || Math.abs(s.odds - f.odds) > 0.0001) changed.push({ ev: s.ev, mk: s.mk, k: s.k, odds: f.odds });
        legs.push({ ev: s.ev, mk: s.mk, k: s.k, ...f });
      }
      // Never accept a price the client didn't see – the odds are decided here, not in the browser.
      if (changed.length) return [409, { error: 'odds_changed', message: 'Odds have changed', changed }];

      const groups = body.type === 'multi' ? [legs] : legs.map(l => [l]);
      return [201, tx(db, () => {
        const ids = [];
        for (const g of groups) {
          const o = Math.round(g.reduce((a, l) => a * l.odds, 1) * 100) / 100;
          const { lastInsertRowid } = db.prepare('INSERT INTO bets (user_id,type,stake_cents,odds,created_at) VALUES (?,?,?,?,?)').run(user.id, g.length > 1 ? 'multi' : 'single', stake, o, Date.now());
          const id = Number(lastInsertRowid);
          const ins = db.prepare('INSERT INTO bet_legs (bet_id,event_id,market,sel,label,match,odds) VALUES (?,?,?,?,?,?,?)');
          g.forEach(l => ins.run(id, l.ev, l.mk, l.k, l.label, l.match, l.odds));
          debit(db, user.id, 'bet_stake', 'house:stakes', stake, `bet:${id}`); // throws insufficient_funds
          ids.push(id);
        }
        return { bet_ids: ids, ...me(user) };
      })];
    },

    'GET /api/bets': ({ user }) => {
      need(user);
      const bets = db.prepare('SELECT * FROM bets WHERE user_id=? ORDER BY id DESC LIMIT 100').all(user.id);
      const legs = db.prepare('SELECT * FROM bet_legs WHERE bet_id=? ORDER BY id');
      return [200, { bets: bets.map(b => ({ id: b.id, type: b.type, stake_cents: b.stake_cents, odds: b.odds, status: b.status, payout_cents: b.payout_cents, created_at: b.created_at,
        legs: legs.all(b.id).map(l => ({ label: l.label, match: l.match, odds: l.odds, result: l.result })) })) }];
    },

    // DEMO ONLY: stands in for a results feed. Settles the caller's open bets randomly, weighted by odds.
    'POST /api/bets/settle-demo': ({ user }) => {
      need(user);
      if (!demoMode) throw new HttpError(404, 'not_found', 'Not found');
      return [200, tx(db, () => {
        let won = 0;
        const open = db.prepare("SELECT * FROM bets WHERE user_id=? AND status='open'").all(user.id);
        for (const b of open) {
          const legs = db.prepare('SELECT * FROM bet_legs WHERE bet_id=?').all(b.id);
          let all = true;
          for (const l of legs) {
            const r = Math.random() < winProbability(l.odds); all &&= r;   // not 1/odds: that would give the house no edge
            db.prepare('UPDATE bet_legs SET result=? WHERE id=?').run(r ? 'won' : 'lost', l.id);
          }
          const payout = all ? Math.floor(b.stake_cents * b.odds) : 0;
          db.prepare('UPDATE bets SET status=?, payout_cents=?, settled_at=? WHERE id=?').run(all ? 'won' : 'lost', payout, Date.now(), b.id);
          if (all) { won++; credit(db, user.id, 'bet_payout', 'house:stakes', payout, `bet:${b.id}`); }
        }
        return { settled: open.length, won, ...me(user) };
      })];
    },

    'GET /api/games': () => {
      if (!gamesEnabled) throw new HttpError(404, 'not_found', 'Not found');   // casino-style games are not offered in real-money mode
      return [200, { games: GAMES.map(publicGame), min_stake_cents: MIN_GAME_STAKE, max_stake_cents: MAX_GAME_STAKE }];
    },

    'POST /api/games/play': ({ user, body }) => {
      if (!gamesEnabled) throw new HttpError(404, 'not_found', 'Not found');
      needActive(user);
      const g = gameById(body.game); if (!g) throw bad('Unknown game', 'unknown_game');
      const stake = money(body.stake_cents, MIN_GAME_STAKE, MAX_GAME_STAKE, 'Stake');
      return [200, tx(db, () => {
        const reels = spin(g), { mult, win } = evaluate(g, reels), payout = Math.floor(stake * mult);
        const { lastInsertRowid } = db.prepare('INSERT INTO game_rounds (user_id,game,stake_cents,reels,mult,payout_cents,created_at) VALUES (?,?,?,?,?,?,?)')
          .run(user.id, g.id, stake, JSON.stringify(reels), mult, payout, Date.now());
        const ref = `round:${lastInsertRowid}`;
        debit(db, user.id, 'game_stake', 'house:games', stake, ref);          // throws insufficient_funds
        if (payout) credit(db, user.id, 'game_win', 'house:games', payout, ref);
        return { reels, symbols: g.symbols, mult, win, payout_cents: payout, ...me(user) };
      })];
    },

    'GET /api/ledger': ({ user }) => {
      need(user);
      const rows = db.prepare(`SELECT t.id, t.kind, t.ref, t.created_at, e.amount_cents FROM ledger_entries e JOIN ledger_txns t ON t.id=e.txn_id
        WHERE e.account=? ORDER BY t.id DESC LIMIT 100`).all(userAccount(user.id));
      return [200, { entries: rows }];
    },
  };
  const DUMMY_HASH = 'scrypt$' + '00'.repeat(16) + '$' + '00'.repeat(64);
  function need(u) { if (!u) throw new HttpError(401, 'unauthenticated', 'Please log in'); }
  function needActive(u) { need(u); if (onBreak(u)) throw new HttpError(403, 'on_break', 'You are on a break. Betting and deposits are paused until it ends.'); }

  /* ---- http plumbing ---- */
  const SECURITY = {
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY',
  };
  // Text responses are gzipped when the browser accepts it. Live odds polling is the site's main data cost
  // for a bettor on prepaid data, and compression cuts it by roughly 80%. Images are already compressed.
  const COMPRESSIBLE = /^(application\/json|text\/|image\/svg)/;
  const send = (res, status, body, headers = {}) => {
    const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
    const head = { ...SECURITY, 'Cache-Control': 'no-store', ...(isJson ? { 'Content-Type': 'application/json' } : {}), ...headers };
    let payload = isJson ? JSON.stringify(body) : body;
    if (COMPRESSIBLE.test(head['Content-Type'] || '')) {
      head.Vary = 'Accept-Encoding';
      if (res.gzipOk && Buffer.byteLength(payload) >= 512) { payload = gzipSync(payload); head['Content-Encoding'] = 'gzip'; }
    }
    res.writeHead(status, head);
    res.end(payload);
  };
  const readBody = req => new Promise((ok, fail) => {
    let size = 0; const chunks = [];
    let tooBig = false;
    req.on('data', c => { if (tooBig) return; size += c.length; if (size > 16_384) { tooBig = true; chunks.length = 0; fail(new HttpError(413, 'too_large', 'Request too large')); } else chunks.push(c); });
    req.on('end', () => { if (tooBig) return; try { ok(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch { fail(bad('Invalid JSON')); } });
    req.on('error', fail);
  });
  const parseCookies = h => Object.fromEntries((h || '').split(';').map(c => c.trim().split(/=(.*)/s).slice(0, 2)).filter(p => p[0]));

  async function serveStatic(res, pathname) {
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    const file = resolve(join(PUBLIC_DIR, rel));
    if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + sep)) return send(res, 403, 'Forbidden');
    try {
      const data = await readFile(file);
      send(res, 200, data, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    } catch { send(res, 404, 'Not found', { 'Content-Type': 'text/plain' }); }
  }

  const server = http.createServer(async (req, res) => {
    res.gzipOk = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    try {
      const url = new URL(req.url, 'http://x');
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
        return await serveStatic(res, url.pathname);
      }
      const handler = routes[`${req.method} ${url.pathname}`];
      if (!handler) return send(res, 404, { error: 'not_found' });
      let body = {};
      if (req.method !== 'GET') {
        // JSON-only + SameSite=Strict cookie => simple CSRF protection.
        if (!(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, 'unsupported_media_type', 'Use application/json');
        body = await readBody(req);
        if (typeof body !== 'object' || body === null || Array.isArray(body)) throw bad('Body must be a JSON object');
      }
      const token = parseCookies(req.headers.cookie)[COOKIE];
      let user = userForToken(db, token);
      if (user) user = settleLimit(db, user);                 // a limit increase whose cooling-off has passed takes effect now
      const [status, payload, headers] = await handler({ body, token, user, ip: req.socket.remoteAddress, query: url.searchParams });
      send(res, status, payload, headers);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.code, message: e.message }, e.status === 413 ? { Connection: 'close' } : {});
      if (e instanceof WalletError) return send(res, e.code === 'insufficient_funds' ? 422 : 500, { error: e.code, message: e.message });
      console.error(e); send(res, 500, { error: 'server_error', message: 'Something went wrong' });
    }
  });
  let closed = false;                                      // 'close' can fire twice if close() is called twice
  server.on('close', () => { if (closed) return; closed = true; clearInterval(ticker); db.close(); });
  return { server, db, odds };
}

// Run directly: `node server/server.js`
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  const { server } = createApp();
  server.listen(port, () => console.log(`ApexBets listening on http://localhost:${port} (demo mode: ${process.env.DEMO_MODE !== 'false'})`));
}
