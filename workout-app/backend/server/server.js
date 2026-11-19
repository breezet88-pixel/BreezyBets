// FitLibrary API (back end only: it serves JSON and uploaded images, never the web pages).
//
// Who can do what:
//   anyone      view published workouts, today's workout of the day, comments and reviews
//   customer    (signed in) add comments and reviews, download today's workout of the day
//   admin       (you)       everything else: add, edit and remove workouts, exercises, pictures,
//                           the workout-of-the-day schedule, comments/reviews and customers
// Customers can only ever register as customers. The single admin account comes from the
// ADMIN_USERNAME / ADMIN_PASSWORD environment variables (the admin signs in with a username,
// customers with an email address, so a customer can never take over the admin name).
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { openDb, inTransaction } from './db.js';
import {
  hashPassword, verifyPassword, DUMMY_HASH, createSession, userForToken, deleteSession, bearer, Limiter,
  createEmailToken, consumeEmailToken,
} from './auth.js';
import { createMailer } from './mailer.js';
import {
  HttpError, IMAGE_NAME, text, normEmail, validEmail, validDay, addDays, cleanWorkout, cleanDonate, DEFAULT_AMOUNTS,
} from './validate.js';
import { buildWorkoutHtml, slug } from './download.js';

const MAX_JSON = 256 * 1024;
const MAX_IMAGE = 5 * 1024 * 1024;
const HOUR = 60 * 60 * 1000;
const SESSION_TTL = { admin: 12 * HOUR, customer: 30 * 24 * HOUR };

const IMAGE_SNIFF = [
  ['png', (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['jpg', (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['webp', (b) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP'],
  ['gif', (b) => b.length > 6 && b.toString('latin1', 0, 4) === 'GIF8'],
];
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

const list = (v) => String(v || '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);

export function createApp(opts = {}) {
  const o = {
    dbPath: './data/fitlibrary.db',
    uploadDir: './data/uploads',
    corsOrigins: list(process.env.CORS_ORIGINS),
    adminUsername: process.env.ADMIN_USERNAME || process.env.ADMIN_EMAIL,
    adminPassword: process.env.ADMIN_PASSWORD,
    mailer: null,                                   // set below if not given
    appUrl: process.env.APP_URL || '',              // web address of the front end, used in email links
    // default: on when real email sending is configured. REQUIRE_EMAIL_VERIFICATION=true/false overrides.
    requireVerified: process.env.REQUIRE_EMAIL_VERIFICATION ? process.env.REQUIRE_EMAIL_VERIFICATION === 'true' : undefined,
    trustProxy: process.env.TRUST_PROXY === 'true',
    timezone: process.env.TIMEZONE || 'Africa/Johannesburg',
    now: () => new Date(),
    loginLimit: 10, accountLoginLimit: 5, registerLimit: 10, feedbackPerHour: 10, forgotPerHour: 3,
    pruneGraceMs: HOUR,
    ...opts,
  };

  fs.mkdirSync(o.uploadDir, { recursive: true });
  const uploadRoot = path.resolve(o.uploadDir);
  const db = openDb(o.dbPath);
  const loginFails = new Limiter();      // wrong passwords per IP
  const accountFails = new Limiter();    // wrong passwords per account, from anywhere
  const registers = new Limiter();
  const emailSends = new Limiter();      // forgot/resend emails per address
  const mailer = o.mailer || createMailer();
  const requireVerifiedOn = o.requireVerified ?? mailer.real;
  const appUrl = (o.appUrl || o.corsOrigins[0] || 'http://localhost:8080').replace(/\/$/, '');
  const VERIFY_TTL = 24 * HOUR;
  const RESET_TTL = HOUR;

  const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: o.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const today = () => dayFmt.format(o.now());

  // The one admin account. Re-running with a new ADMIN_PASSWORD changes the password (and signs the admin out).
  const ready = (async () => {
    if (!o.adminUsername || !o.adminPassword) return;
    const login = normEmail(o.adminUsername);
    const row = db.prepare('SELECT * FROM users WHERE email = ?').get(login);
    if (!row) {
      db.prepare('INSERT INTO users (email, name, role, password_hash, email_verified, created_at) VALUES (?,?,?,?,1,?)')
        .run(login, 'Coach', 'admin', await hashPassword(o.adminPassword), new Date().toISOString());
    } else if (row.role !== 'admin' || !(await verifyPassword(o.adminPassword, row.password_hash))) {
      db.prepare("UPDATE users SET role = 'admin', blocked = 0, email_verified = 1, password_hash = ? WHERE id = ?")
        .run(await hashPassword(o.adminPassword), row.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
    }
  })();

  function sendEmail(to, subject, text) {
    // not awaited: the reply must not reveal whether an address has an account
    Promise.resolve().then(() => mailer.send({ to, subject, text })).catch((e) => console.error('email failed:', e.message));
  }
  function sendVerifyEmail(user) {
    const token = createEmailToken(db, user.id, 'verify', VERIFY_TTL);
    sendEmail(user.email, 'Confirm your email for FitLibrary',
      `Hi ${user.name},\n\nConfirm your email address to leave reviews and download the workout of the day:\n${appUrl}/#/verify?token=${token}\n\nThis link works for 24 hours. If you did not create an account, ignore this email.`);
  }

  // ---------- http helpers ----------
  const clientIp = (req) => {
    if (o.trustProxy) {
      const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (xf) return xf;
    }
    return req.socket.remoteAddress || 'unknown';
  };

  function json(res, status, body, headers = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  }

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) { reject(new HttpError(413, 'too_large', 'That is too large.')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  async function readJson(req) {
    const buf = await readBody(req, MAX_JSON);
    try {
      const v = JSON.parse(buf.toString('utf8') || '{}');
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('shape');
      return v;
    } catch { throw new HttpError(400, 'bad_json', 'Request body is not valid JSON.'); }
  }

  function applyCors(req, res, isUpload) {
    const origin = req.headers.origin;
    if (isUpload) {
      // Public pictures: any site/app may display them. No credentials involved.
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      return;
    }
    if (origin && o.corsOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
      res.setHeader('Access-Control-Max-Age', '600');
    }
  }

  // ---------- who is calling ----------
  const currentUser = (req) => userForToken(db, bearer(req));
  function requireUser(req) {
    const u = currentUser(req);
    if (!u) throw new HttpError(401, 'sign_in_required', 'Please sign in.');
    return u;
  }
  function requireVerified(user) {
    if (requireVerifiedOn && !user.email_verified) {
      throw new HttpError(403, 'verify_email', 'Please confirm your email address first. Check your inbox for the link.');
    }
  }
  function requireAdmin(req) {
    const u = requireUser(req);
    if (u.role !== 'admin') throw new HttpError(403, 'forbidden', 'Only the coach can do that.');
    return u;
  }

  // ---------- data ----------
  const exercisesFor = db.prepare('SELECT id, name, muscles, equipment, sets, reps, rest_sec, cues, image FROM exercises WHERE workout_id = ? ORDER BY position');
  const ratingFor = db.prepare('SELECT AVG(rating) AS avg, COUNT(rating) AS n FROM feedback WHERE workout_id = ?');

  function ratingOf(id) {
    const r = ratingFor.get(id);
    return { rating_avg: r.n ? Math.round(r.avg * 10) / 10 : null, rating_count: r.n };
  }

  function loadWorkout(row) {
    return {
      id: row.id, title: row.title, description: row.description, category: row.category, level: row.level,
      duration_min: row.duration_min, published: !!row.published, updated_at: row.updated_at,
      ...ratingOf(row.id), exercises: exercisesFor.all(row.id).map((e) => ({ ...e })),
    };
  }

  function summary(row) {
    const ex = exercisesFor.all(row.id);
    return {
      id: row.id, title: row.title, description: row.description, category: row.category, level: row.level,
      duration_min: row.duration_min, published: !!row.published, updated_at: row.updated_at,
      exercise_count: ex.length, cover: (ex.find((e) => e.image) || {}).image || '', ...ratingOf(row.id),
    };
  }

  function writeExercises(workoutId, items) {
    const ins = db.prepare('INSERT INTO exercises (workout_id, position, name, muscles, equipment, sets, reps, rest_sec, cues, image) VALUES (?,?,?,?,?,?,?,?,?,?)');
    items.forEach((e, i) => ins.run(workoutId, i, e.name, e.muscles, e.equipment, e.sets, e.reps, e.rest_sec, e.cues, e.image));
  }

  // Delete uploaded pictures that no exercise uses any more (keeps brand-new uploads for a grace period).
  function pruneImages() {
    const used = new Set(db.prepare("SELECT DISTINCT image FROM exercises WHERE image <> ''").all().map((r) => r.image));
    for (const f of fs.readdirSync(uploadRoot)) {
      if (!IMAGE_NAME.test(f) || used.has(f)) continue;
      const p = path.join(uploadRoot, f);
      try { if (Date.now() - fs.statSync(p).mtimeMs >= o.pruneGraceMs) fs.unlinkSync(p); } catch { /* already gone */ }
    }
  }

  // ---- donations (optional, voluntary; nothing in the app depends on them) ----
  function donateConfig() {
    const get = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value;
    let amounts = DEFAULT_AMOUNTS;
    try { const a = JSON.parse(get('donate_amounts') || 'null'); if (Array.isArray(a)) amounts = a; } catch { /* keep default */ }
    const url = get('donate_url') || '';
    return { enabled: !!url, url, amount_url: get('donate_amount_url') || '', message: get('donate_message') || '', amounts };
  }

  function wodRow(day) {
    return db.prepare('SELECT w.* FROM wod_schedule s JOIN workouts w ON w.id = s.workout_id WHERE s.day = ? AND w.published = 1').get(day);
  }

  const feedbackOut = (r) => ({ id: r.id, name: r.name, rating: r.rating, body: r.body, created_at: r.created_at });

  // ---------- routes ----------
  async function api(req, res, url) {
    const p = url.pathname;
    const m = req.method;
    let mt;

    if (m === 'GET' && p === '/api/health') return json(res, 200, { ok: true });

    // ===== public =====
    if (m === 'GET' && p === '/api/workouts') {
      const rows = db.prepare('SELECT * FROM workouts WHERE published = 1 ORDER BY updated_at DESC, id DESC').all();
      return json(res, 200, { workouts: rows.map(summary) }, { 'Cache-Control': 'no-cache' });
    }
    if (m === 'GET' && (mt = p.match(/^\/api\/workouts\/(\d+)$/))) {
      const row = db.prepare('SELECT * FROM workouts WHERE id = ? AND published = 1').get(Number(mt[1]));
      if (!row) throw new HttpError(404, 'not_found', 'Workout not found.');
      return json(res, 200, { workout: loadWorkout(row) }, { 'Cache-Control': 'no-cache' });
    }
    if (m === 'GET' && (mt = p.match(/^\/api\/workouts\/(\d+)\/feedback$/))) {
      const id = Number(mt[1]);
      if (!db.prepare('SELECT 1 FROM workouts WHERE id = ? AND published = 1').get(id)) throw new HttpError(404, 'not_found', 'Workout not found.');
      const rows = db.prepare('SELECT f.id, u.name, f.rating, f.body, f.created_at FROM feedback f JOIN users u ON u.id = f.user_id WHERE f.workout_id = ? ORDER BY f.id DESC LIMIT 100').all(id);
      const viewer = currentUser(req);
      const youRated = viewer ? !!db.prepare('SELECT 1 FROM feedback WHERE workout_id = ? AND user_id = ? AND rating IS NOT NULL').get(id, viewer.id) : false;
      return json(res, 200, { feedback: rows.map(feedbackOut), you_rated: youRated, ...ratingOf(id) });
    }
    if (m === 'GET' && p === '/api/donate') return json(res, 200, donateConfig(), { 'Cache-Control': 'no-cache' });
    if (m === 'GET' && p === '/api/wod') {
      const day = today();
      const row = wodRow(day);
      return json(res, 200, { day, workout: row ? loadWorkout(row) : null }, { 'Cache-Control': 'no-cache' });
    }

    // ===== accounts =====
    if (m === 'POST' && p === '/api/auth/register') {
      const ip = clientIp(req);
      if (registers.count(ip) >= o.registerLimit) throw new HttpError(429, 'too_many_attempts', 'Too many sign-ups from here. Try again later.');
      const b = await readJson(req);
      const name = text(b.name, 60, 'Name', true);
      const email = normEmail(b.email);
      if (!validEmail(email)) throw new HttpError(400, 'invalid', 'Enter a valid email address.');
      const password = String(b.password ?? '');
      if (password.length < 8 || password.length > 200) throw new HttpError(400, 'invalid', 'Password must be at least 8 characters.');
      if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'email_taken', 'That email already has an account. Try signing in.');
      registers.add(ip, HOUR);
      // role is always 'customer': nothing the client sends can create an admin
      const r = db.prepare("INSERT INTO users (email, name, role, password_hash, created_at) VALUES (?,?,'customer',?,?)")
        .run(email, name, await hashPassword(password), new Date().toISOString());
      const id = Number(r.lastInsertRowid);
      const token = createSession(db, id, SESSION_TTL.customer);
      sendVerifyEmail({ id, name, email });
      return json(res, 201, { token, user: { id, name, email, role: 'customer', email_verified: 0 }, verification_required: requireVerifiedOn });
    }
    if (m === 'POST' && p === '/api/auth/login') {
      const ip = clientIp(req);
      if (loginFails.count(ip) >= o.loginLimit) throw new HttpError(429, 'too_many_attempts', 'Too many attempts. Try again in 15 minutes.');
      const b = await readJson(req);
      const login = normEmail(b.login ?? b.email);   // customers use their email, the coach uses a username
      // Also limit per account, so guessing from many addresses at once does not get around the limit.
      if (accountFails.count(login) >= o.accountLoginLimit) throw new HttpError(429, 'too_many_attempts', 'Too many wrong passwords for this account. Try again in 15 minutes.');
      const row = db.prepare('SELECT * FROM users WHERE email = ?').get(login);
      const ok = await verifyPassword(String(b.password ?? '').slice(0, 200), row ? row.password_hash : DUMMY_HASH);
      if (!row || !ok) {
        loginFails.add(ip, 15 * 60 * 1000);
        accountFails.add(login, 15 * 60 * 1000);
        throw new HttpError(401, 'bad_credentials', 'Wrong username/email or password.');
      }
      if (row.blocked) throw new HttpError(403, 'blocked', 'This account has been blocked.');
      loginFails.clear(ip);
      accountFails.clear(login);
      const token = createSession(db, row.id, SESSION_TTL[row.role]);
      return json(res, 200, {
        token, verification_required: requireVerifiedOn,
        user: { id: row.id, name: row.name, email: row.email, role: row.role, email_verified: row.email_verified },
      });
    }
    if (m === 'POST' && p === '/api/auth/logout') {
      deleteSession(db, bearer(req));
      return json(res, 200, { ok: true });
    }
    if (m === 'GET' && p === '/api/me') {
      return json(res, 200, { user: requireUser(req), verification_required: requireVerifiedOn });
    }
    if (m === 'POST' && p === '/api/auth/verify') {
      const id = consumeEmailToken(db, (await readJson(req)).token, 'verify');
      if (!id) throw new HttpError(400, 'bad_link', 'That link has expired or was already used. Sign in and ask for a new one.');
      db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(id);
      return json(res, 200, { ok: true });
    }
    if (m === 'POST' && p === '/api/auth/resend-verification') {
      const user = requireUser(req);
      if (user.email_verified) return json(res, 200, { ok: true });
      if (emailSends.count(`verify:${user.id}`) >= o.forgotPerHour) throw new HttpError(429, 'slow_down', 'We already sent you a few emails. Please check your inbox and spam folder.');
      emailSends.add(`verify:${user.id}`, HOUR);
      sendVerifyEmail(user);
      return json(res, 200, { ok: true });
    }
    if (m === 'POST' && p === '/api/auth/forgot') {
      const ip = clientIp(req);
      const email = normEmail((await readJson(req)).email);
      if (emailSends.count(`ip:${ip}`) >= 10) throw new HttpError(429, 'slow_down', 'Too many requests. Try again later.');
      emailSends.add(`ip:${ip}`, HOUR);
      const row = validEmail(email) ? db.prepare("SELECT * FROM users WHERE email = ? AND role = 'customer' AND blocked = 0").get(email) : null;
      if (row && emailSends.count(`reset:${row.id}`) < o.forgotPerHour) {
        emailSends.add(`reset:${row.id}`, HOUR);
        const token = createEmailToken(db, row.id, 'reset', RESET_TTL);
        sendEmail(row.email, 'Reset your FitLibrary password',
          `Hi ${row.name},\n\nChoose a new password here:\n${appUrl}/#/reset?token=${token}\n\nThis link works for 1 hour. If you did not ask for it, ignore this email: your password has not changed.`);
      }
      // same answer whether or not the address has an account
      return json(res, 200, { ok: true });
    }
    if (m === 'POST' && p === '/api/auth/reset') {
      const b = await readJson(req);
      const password = String(b.password ?? '');
      if (password.length < 8 || password.length > 200) throw new HttpError(400, 'invalid', 'Password must be at least 8 characters.');
      const id = consumeEmailToken(db, b.token, 'reset');
      if (!id) throw new HttpError(400, 'bad_link', 'That link has expired or was already used. Ask for a new one.');
      // they proved they own the inbox, so the address counts as confirmed; everyone is signed out
      db.prepare("UPDATE users SET password_hash = ?, email_verified = 1 WHERE id = ? AND role = 'customer'").run(await hashPassword(password), id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      return json(res, 200, { ok: true });
    }

    // ===== customers (signed in) =====
    if (m === 'POST' && (mt = p.match(/^\/api\/workouts\/(\d+)\/feedback$/))) {
      const user = requireUser(req);
      requireVerified(user);
      const id = Number(mt[1]);
      if (!db.prepare('SELECT 1 FROM workouts WHERE id = ? AND published = 1').get(id)) throw new HttpError(404, 'not_found', 'Workout not found.');
      const b = await readJson(req);
      let rating = null;
      if (b.rating !== undefined && b.rating !== null && b.rating !== '') {
        rating = Number(b.rating);
        if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new HttpError(400, 'invalid', 'Rating must be 1 to 5 stars.');
      }
      const body = text(b.body, 1000, 'Comment');
      if (rating === null && !body) throw new HttpError(400, 'invalid', 'Write a comment or choose a star rating.');
      const since = new Date(Date.now() - HOUR).toISOString();
      if (db.prepare('SELECT COUNT(*) AS n FROM feedback WHERE user_id = ? AND created_at > ?').get(user.id, since).n >= o.feedbackPerHour) {
        throw new HttpError(429, 'slow_down', 'You are posting too fast. Please try again later.');
      }
      if (rating !== null && db.prepare('SELECT 1 FROM feedback WHERE workout_id = ? AND user_id = ? AND rating IS NOT NULL').get(id, user.id)) {
        throw new HttpError(409, 'already_reviewed', 'You have already reviewed this workout.');
      }
      const created = new Date().toISOString();
      const r = db.prepare('INSERT INTO feedback (workout_id, user_id, rating, body, created_at) VALUES (?,?,?,?,?)').run(id, user.id, rating, body, created);
      return json(res, 201, { feedback: feedbackOut({ id: Number(r.lastInsertRowid), name: user.name, rating, body, created_at: created }), ...ratingOf(id) });
    }
    if (m === 'GET' && p === '/api/wod/download') {
      requireVerified(requireUser(req));
      const day = today();
      const row = wodRow(day);
      if (!row) throw new HttpError(404, 'no_wod', 'There is no workout of the day to download yet.');
      const html = buildWorkoutHtml(loadWorkout(row), day, uploadRoot);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': `attachment; filename="${slug(row.title)}-${day}.html"`,
        'Cache-Control': 'no-store',
      });
      return res.end(html);
    }

    // ===== admin only: everything below =====
    if (p.startsWith('/api/admin/')) requireAdmin(req);

    if (m === 'GET' && p === '/api/admin/workouts') {
      return json(res, 200, { workouts: db.prepare('SELECT * FROM workouts ORDER BY updated_at DESC, id DESC').all().map(summary) });
    }
    if (m === 'GET' && (mt = p.match(/^\/api\/admin\/workouts\/(\d+)$/))) {
      const row = db.prepare('SELECT * FROM workouts WHERE id = ?').get(Number(mt[1]));
      if (!row) throw new HttpError(404, 'not_found', 'Workout not found.');
      return json(res, 200, { workout: loadWorkout(row) });
    }
    if (m === 'POST' && p === '/api/admin/workouts') {
      const w = cleanWorkout(await readJson(req), uploadRoot);
      const now = new Date().toISOString();
      const id = inTransaction(db, () => {
        const r = db.prepare('INSERT INTO workouts (title, description, category, level, duration_min, published, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
          .run(w.title, w.description, w.category, w.level, w.duration_min, w.published, now, now);
        writeExercises(Number(r.lastInsertRowid), w.exercises);
        return Number(r.lastInsertRowid);
      });
      return json(res, 201, { workout: loadWorkout(db.prepare('SELECT * FROM workouts WHERE id = ?').get(id)) });
    }
    if (m === 'PUT' && (mt = p.match(/^\/api\/admin\/workouts\/(\d+)$/))) {
      const id = Number(mt[1]);
      if (!db.prepare('SELECT 1 FROM workouts WHERE id = ?').get(id)) throw new HttpError(404, 'not_found', 'Workout not found.');
      const w = cleanWorkout(await readJson(req), uploadRoot);
      inTransaction(db, () => {
        db.prepare('UPDATE workouts SET title=?, description=?, category=?, level=?, duration_min=?, published=?, updated_at=? WHERE id=?')
          .run(w.title, w.description, w.category, w.level, w.duration_min, w.published, new Date().toISOString(), id);
        db.prepare('DELETE FROM exercises WHERE workout_id = ?').run(id);
        writeExercises(id, w.exercises);
      });
      pruneImages();
      return json(res, 200, { workout: loadWorkout(db.prepare('SELECT * FROM workouts WHERE id = ?').get(id)) });
    }
    if (m === 'DELETE' && (mt = p.match(/^\/api\/admin\/workouts\/(\d+)$/))) {
      const r = db.prepare('DELETE FROM workouts WHERE id = ?').run(Number(mt[1]));
      if (!r.changes) throw new HttpError(404, 'not_found', 'Workout not found.');
      pruneImages();
      return json(res, 200, { ok: true });
    }

    if (m === 'POST' && p === '/api/admin/upload') {
      const buf = await readBody(req, MAX_IMAGE);
      const kind = IMAGE_SNIFF.find(([, test]) => test(buf));
      if (!kind) throw new HttpError(400, 'bad_image', 'Upload a PNG, JPG, WebP or GIF image (max 5 MB).');
      const name = `${crypto.randomBytes(16).toString('hex')}.${kind[0]}`;
      fs.writeFileSync(path.join(uploadRoot, name), buf);
      return json(res, 201, { file: name });
    }

    // donation link + message
    if (m === 'GET' && p === '/api/admin/donate') return json(res, 200, donateConfig());
    if (m === 'PUT' && p === '/api/admin/donate') {
      const d = cleanDonate(await readJson(req));
      const put = db.prepare('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
      inTransaction(db, () => {
        put.run('donate_url', d.url); put.run('donate_amount_url', d.amount_url);
        put.run('donate_message', d.message); put.run('donate_amounts', JSON.stringify(d.amounts));
      });
      return json(res, 200, donateConfig());
    }

    // workout of the day schedule
    if (m === 'GET' && p === '/api/admin/wod') {
      const from = addDays(today(), -7);
      const rows = db.prepare('SELECT s.day, w.id AS workout_id, w.title, w.published FROM wod_schedule s JOIN workouts w ON w.id = s.workout_id WHERE s.day >= ? ORDER BY s.day').all(from);
      return json(res, 200, { today: today(), schedule: rows.map((r) => ({ ...r, published: !!r.published })) });
    }
    if (m === 'PUT' && (mt = p.match(/^\/api\/admin\/wod\/([^/]+)$/))) {
      if (!validDay(mt[1])) throw new HttpError(400, 'invalid', 'Pick a valid date.');
      const b = await readJson(req);
      if (!db.prepare('SELECT 1 FROM workouts WHERE id = ?').get(Number(b.workout_id))) throw new HttpError(400, 'invalid', 'Pick a workout.');
      db.prepare('INSERT INTO wod_schedule (day, workout_id) VALUES (?,?) ON CONFLICT(day) DO UPDATE SET workout_id = excluded.workout_id').run(mt[1], Number(b.workout_id));
      return json(res, 200, { ok: true });
    }
    if (m === 'DELETE' && (mt = p.match(/^\/api\/admin\/wod\/([^/]+)$/))) {
      if (!validDay(mt[1])) throw new HttpError(400, 'invalid', 'Pick a valid date.');
      db.prepare('DELETE FROM wod_schedule WHERE day = ?').run(mt[1]);
      return json(res, 200, { ok: true });
    }

    // moderation: comments and reviews
    if (m === 'GET' && p === '/api/admin/feedback') {
      const rows = db.prepare(
        `SELECT f.id, f.rating, f.body, f.created_at, w.title AS workout, u.name, u.email, u.id AS user_id
         FROM feedback f JOIN workouts w ON w.id = f.workout_id JOIN users u ON u.id = f.user_id ORDER BY f.id DESC LIMIT 200`).all();
      return json(res, 200, { feedback: rows });
    }
    if (m === 'DELETE' && (mt = p.match(/^\/api\/admin\/feedback\/(\d+)$/))) {
      const r = db.prepare('DELETE FROM feedback WHERE id = ?').run(Number(mt[1]));
      if (!r.changes) throw new HttpError(404, 'not_found', 'Not found.');
      return json(res, 200, { ok: true });
    }

    // customers
    if (m === 'GET' && p === '/api/admin/users') {
      const rows = db.prepare(
        `SELECT u.id, u.name, u.email, u.role, u.blocked, u.created_at, (SELECT COUNT(*) FROM feedback f WHERE f.user_id = u.id) AS feedback_count
         FROM users u ORDER BY u.id DESC LIMIT 500`).all();
      return json(res, 200, { users: rows.map((r) => ({ ...r, blocked: !!r.blocked })) });
    }
    if (m === 'PUT' && (mt = p.match(/^\/api\/admin\/users\/(\d+)$/))) {
      const id = Number(mt[1]);
      const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      if (!target) throw new HttpError(404, 'not_found', 'Not found.');
      if (target.role === 'admin') throw new HttpError(400, 'invalid', 'The admin account cannot be blocked.');
      const blocked = (await readJson(req)).blocked ? 1 : 0;
      db.prepare('UPDATE users SET blocked = ? WHERE id = ?').run(blocked, id);
      if (blocked) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      return json(res, 200, { ok: true });
    }
    if (m === 'DELETE' && (mt = p.match(/^\/api\/admin\/users\/(\d+)$/))) {
      const target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(mt[1]));
      if (!target) throw new HttpError(404, 'not_found', 'Not found.');
      if (target.role === 'admin') throw new HttpError(400, 'invalid', 'The admin account cannot be deleted.');
      db.prepare('DELETE FROM users WHERE id = ?').run(target.id); // their sessions, comments and reviews go with them
      return json(res, 200, { ok: true });
    }

    throw new HttpError(404, 'not_found', 'Not found.');
  }

  function serveUpload(res, name) {
    if (!IMAGE_NAME.test(name)) throw new HttpError(404, 'not_found', 'Not found.');
    const file = path.join(uploadRoot, name);
    let stat;
    try { stat = fs.statSync(file); } catch { throw new HttpError(404, 'not_found', 'Not found.'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(name)],
      'Content-Length': stat.size,
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    fs.createReadStream(file).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    // This server only returns data, so lock the responses down completely.
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const url = new URL(req.url, 'http://localhost');
      const isUpload = url.pathname.startsWith('/uploads/');
      applyCors(req, res, isUpload);
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (isUpload && (req.method === 'GET' || req.method === 'HEAD')) return serveUpload(res, url.pathname.slice('/uploads/'.length));
      throw new HttpError(404, 'not_found', 'Not found.');
    } catch (e) {
      if (res.headersSent) return res.destroy();
      if (e instanceof HttpError) return json(res, e.status, { error: e.code, message: e.message });
      console.error(e);
      return json(res, 500, { error: 'server_error', message: 'Something went wrong.' });
    }
  });

  return { server, db, ready, close: () => new Promise((r) => server.close(() => { db.close(); r(); })) };
}
