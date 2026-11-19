// FitLibrary API (back end only: it serves JSON and, locally, uploaded pictures; never the web pages).
//
// Who can do what:
//   anyone      view published workouts, today's workout of the day, comments and reviews
//   customer    (signed in) add comments and reviews, download today's workout of the day
//   admin       (you)       everything else: add, edit and remove workouts, exercises, pictures,
//                           the workout-of-the-day schedule, comments/reviews and customers
// Customers can only ever register as customers. The single admin account comes from the
// ADMIN_USERNAME / ADMIN_PASSWORD environment variables (the admin signs in with a username,
// customers with an email address, so a customer can never take over the admin name).
//
// createHandler() is host-neutral: the same request handler runs as a local Node server (createApp,
// below) and as a Vercel function (../../api/handler.js). Storage comes from ./store.js (SQLite file
// or Turso) and ./files.js (folder or Vercel Blob), chosen by environment variables.
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { openStore } from './store.js';
import { openFiles, LOCAL_NAME } from './files.js';
import { migrate } from './db.js';
import {
  hashPassword, verifyPassword, DUMMY_HASH, createSession, userForToken, deleteSession, bearer,
  createEmailToken, consumeEmailToken, limits,
} from './auth.js';
import { createMailer } from './mailer.js';
import {
  HttpError, text, normEmail, validEmail, validDay, addDays, cleanWorkout, cleanDonate, DEFAULT_AMOUNTS,
} from './validate.js';
import { buildWorkoutHtml, slug } from './download.js';

const MAX_JSON = 256 * 1024;
const MAX_IMAGE = 4 * 1024 * 1024; // Vercel functions accept request bodies up to 4.5 MB
const HOUR = 60 * 60 * 1000;
const SESSION_TTL = { admin: 12 * HOUR, customer: 30 * 24 * HOUR };

const IMAGE_SNIFF = [
  ['png', 'image/png', (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['jpg', 'image/jpeg', (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['webp', 'image/webp', (b) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP'],
  ['gif', 'image/gif', (b) => b.length > 6 && b.toString('latin1', 0, 4) === 'GIF8'],
];
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

const list = (v) => String(v || '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);

export function createHandler(opts = {}) {
  const o = {
    dbPath: './data/fitlibrary.db',
    uploadDir: './data/uploads',
    store: null,                                    // a ready store/files can be passed in (tests); otherwise from env
    files: null,
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
    maxEmbedBytes: Infinity,                        // size cap for the downloadable workout (set on Vercel)
    ...opts,
  };

  const mailer = o.mailer || createMailer();
  const requireVerifiedOn = o.requireVerified ?? mailer.real;
  const appUrl = (o.appUrl || o.corsOrigins[0] || 'http://localhost:8080').replace(/\/$/, '');
  const VERIFY_TTL = 24 * HOUR;
  const RESET_TTL = HOUR;
  const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: o.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const today = () => dayFmt.format(o.now());

  let db;     // the database store
  let files;  // the picture store
  let lim;    // rate-limit counters

  // Start-up: open storage, create/upgrade tables, and make sure the one admin account matches the settings.
  const ready = (async () => {
    db = o.store || await openStore({ dbPath: o.dbPath });
    files = o.files || openFiles({ uploadDir: o.uploadDir });
    lim = limits(db);
    await migrate(db);
    if (!o.adminUsername || !o.adminPassword) return;
    const login = normEmail(o.adminUsername);
    const row = await db.get('SELECT * FROM users WHERE email = ?', [login]);
    if (!row) {
      await db.run('INSERT INTO users (email, name, role, password_hash, email_verified, created_at) VALUES (?,?,?,?,1,?)',
        [login, 'Coach', 'admin', await hashPassword(o.adminPassword), new Date().toISOString()]);
    } else if (row.role !== 'admin' || !(await verifyPassword(o.adminPassword, row.password_hash))) {
      // a changed ADMIN_PASSWORD takes effect and signs the coach out everywhere
      await db.batch([
        ["UPDATE users SET role = 'admin', blocked = 0, email_verified = 1, password_hash = ? WHERE id = ?", [await hashPassword(o.adminPassword), row.id]],
        ['DELETE FROM sessions WHERE user_id = ?', [row.id]],
      ]);
    }
  })();

  function sendEmail(to, subject, body) {
    // not awaited: the reply must not reveal whether an address has an account
    Promise.resolve().then(() => mailer.send({ to, subject, text: body })).catch((e) => console.error('email failed:', e.message));
  }
  async function sendVerifyEmail(user) {
    const token = await createEmailToken(db, user.id, 'verify', VERIFY_TTL);
    sendEmail(user.email, 'Confirm your email for FitLibrary',
      `Hi ${user.name},\n\nConfirm your email address to leave reviews and download the workout of the day:\n${appUrl}/#/verify?token=${token}\n\nThis link works for 24 hours. If you did not create an account, ignore this email.`);
  }

  // ---------- http helpers ----------
  const clientIp = (req) => {
    if (o.trustProxy) {
      const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (xf) return xf;
    }
    return req.socket?.remoteAddress || 'unknown';
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
  async function requireUser(req) {
    const u = await currentUser(req);
    if (!u) throw new HttpError(401, 'sign_in_required', 'Please sign in.');
    return u;
  }
  function requireVerified(user) {
    if (requireVerifiedOn && !user.email_verified) {
      throw new HttpError(403, 'verify_email', 'Please confirm your email address first. Check your inbox for the link.');
    }
  }
  async function requireAdmin(req) {
    const u = await requireUser(req);
    if (u.role !== 'admin') throw new HttpError(403, 'forbidden', 'Only the coach can do that.');
    return u;
  }

  // ---------- data ----------
  const exercisesFor = (id) => db.all('SELECT id, name, muscles, equipment, sets, reps, rest_sec, cues, image FROM exercises WHERE workout_id = ? ORDER BY position', [id]);

  async function ratingOf(id) {
    const r = await db.get('SELECT AVG(rating) AS avg, COUNT(rating) AS n FROM feedback WHERE workout_id = ?', [id]);
    return { rating_avg: r.n ? Math.round(r.avg * 10) / 10 : null, rating_count: r.n };
  }

  async function loadWorkout(row) {
    return {
      id: row.id, title: row.title, description: row.description, category: row.category, level: row.level,
      duration_min: row.duration_min, published: !!row.published, updated_at: row.updated_at,
      ...(await ratingOf(row.id)), exercises: await exercisesFor(row.id),
    };
  }

  async function summary(row) {
    const ex = await exercisesFor(row.id);
    return {
      id: row.id, title: row.title, description: row.description, category: row.category, level: row.level,
      duration_min: row.duration_min, published: !!row.published, updated_at: row.updated_at,
      exercise_count: ex.length, cover: (ex.find((e) => e.image) || {}).image || '', ...(await ratingOf(row.id)),
    };
  }

  const insertExercises = (workoutId, items) => items.map((e, i) => [
    'INSERT INTO exercises (workout_id, position, name, muscles, equipment, sets, reps, rest_sec, cues, image) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [workoutId, i, e.name, e.muscles, e.equipment, e.sets, e.reps, e.rest_sec, e.cues, e.image],
  ]);

  async function cleanWorkoutChecked(body) {
    const w = cleanWorkout(body, files);
    for (const [i, e] of w.exercises.entries()) {
      if (e.image && !(await files.exists(e.image))) throw new HttpError(400, 'invalid', `Exercise ${i + 1} image was not found. Upload it again.`);
    }
    return w;
  }

  // Delete uploaded pictures that no exercise uses any more (keeps brand-new uploads for a grace period).
  async function pruneImages() {
    try {
      const used = new Set((await db.all("SELECT DISTINCT image FROM exercises WHERE image <> ''")).map((r) => r.image));
      const stale = (await files.list()).filter((f) => !used.has(f.ref) && Date.now() - f.uploadedAt >= o.pruneGraceMs).map((f) => f.ref);
      await files.remove(stale);
    } catch (e) { console.error('picture clean-up failed:', e.message); } // never fail the coach's save over this
  }

  // ---- donations (optional, voluntary; nothing in the app depends on them) ----
  async function donateConfig() {
    const rows = await db.all("SELECT key, value FROM settings WHERE key LIKE 'donate_%'");
    const get = (k) => rows.find((r) => r.key === k)?.value;
    let amounts = DEFAULT_AMOUNTS;
    try { const a = JSON.parse(get('donate_amounts') || 'null'); if (Array.isArray(a)) amounts = a; } catch { /* keep default */ }
    const url = get('donate_url') || '';
    return { enabled: !!url, url, amount_url: get('donate_amount_url') || '', message: get('donate_message') || '', amounts };
  }

  const wodRow = (day) => db.get('SELECT w.* FROM wod_schedule s JOIN workouts w ON w.id = s.workout_id WHERE s.day = ? AND w.published = 1', [day]);
  const publishedExists = (id) => db.get('SELECT 1 AS ok FROM workouts WHERE id = ? AND published = 1', [id]);
  const feedbackOut = (r) => ({ id: r.id, name: r.name, rating: r.rating, body: r.body, created_at: r.created_at });
  const mapAll = (rows, fn) => Promise.all(rows.map(fn));

  // ---------- routes ----------
  async function api(req, res, url) {
    const p = url.pathname;
    const m = req.method;
    let mt;

    if (m === 'GET' && p === '/api/health') return json(res, 200, { ok: true });

    // ===== public =====
    if (m === 'GET' && p === '/api/workouts') {
      const rows = await db.all('SELECT * FROM workouts WHERE published = 1 ORDER BY updated_at DESC, id DESC');
      return json(res, 200, { workouts: await mapAll(rows, summary) }, { 'Cache-Control': 'no-cache' });
    }
    if (m === 'GET' && (mt = p.match(/^\/api\/workouts\/(\d+)$/))) {
      const row = await db.get('SELECT * FROM workouts WHERE id = ? AND published = 1', [Number(mt[1])]);
      if (!row) throw new HttpError(404, 'not_found', 'Workout not found.');
      return json(res, 200, { workout: await loadWorkout(row) }, { 'Cache-Control': 'no-cache' });
    }
    if (m === 'GET' && (mt = p.match(/^\/api\/workouts\/(\d+)\/feedback$/))) {
      const id = Number(mt[1]);
      if (!(await publishedExists(id))) throw new HttpError(404, 'not_found', 'Workout not found.');
      const rows = await db.all('SELECT f.id, u.name, f.rating, f.body, f.created_at FROM feedback f JOIN users u ON u.id = f.user_id WHERE f.workout_id = ? ORDER BY f.id DESC LIMIT 100', [id]);
      const viewer = await currentUser(req);
      const youRated = viewer ? !!(await db.get('SELECT 1 AS ok FROM feedback WHERE workout_id = ? AND user_id = ? AND rating IS NOT NULL', [id, viewer.id])) : false;
      return json(res, 200, { feedback: rows.map(feedbackOut), you_rated: youRated, ...(await ratingOf(id)) });
    }
    if (m === 'GET' && p === '/api/donate') return json(res, 200, await donateConfig(), { 'Cache-Control': 'no-cache' });
    if (m === 'GET' && p === '/api/wod') {
      const day = today();
      const row = await wodRow(day);
      return json(res, 200, { day, workout: row ? await loadWorkout(row) : null }, { 'Cache-Control': 'no-cache' });
    }

    // ===== accounts =====
    if (m === 'POST' && p === '/api/auth/register') {
      const ip = clientIp(req);
      if (await lim.count(`register:${ip}`) >= o.registerLimit) throw new HttpError(429, 'too_many_attempts', 'Too many sign-ups from here. Try again later.');
      const b = await readJson(req);
      const name = text(b.name, 60, 'Name', true);
      const email = normEmail(b.email);
      if (!validEmail(email)) throw new HttpError(400, 'invalid', 'Enter a valid email address.');
      const password = String(b.password ?? '');
      if (password.length < 8 || password.length > 200) throw new HttpError(400, 'invalid', 'Password must be at least 8 characters.');
      if (await db.get('SELECT 1 AS ok FROM users WHERE email = ?', [email])) throw new HttpError(409, 'email_taken', 'That email already has an account. Try signing in.');
      await lim.add(`register:${ip}`, HOUR);
      // role is always 'customer': nothing the client sends can create an admin
      const r = await db.run("INSERT INTO users (email, name, role, password_hash, created_at) VALUES (?,?,'customer',?,?)",
        [email, name, await hashPassword(password), new Date().toISOString()]);
      const id = r.lastInsertRowid;
      const token = await createSession(db, id, SESSION_TTL.customer);
      await sendVerifyEmail({ id, name, email });
      return json(res, 201, { token, user: { id, name, email, role: 'customer', email_verified: 0 }, verification_required: requireVerifiedOn });
    }
    if (m === 'POST' && p === '/api/auth/login') {
      const ip = clientIp(req);
      if (await lim.count(`login-ip:${ip}`) >= o.loginLimit) throw new HttpError(429, 'too_many_attempts', 'Too many attempts. Try again in 15 minutes.');
      const b = await readJson(req);
      const login = normEmail(b.login ?? b.email);   // customers use their email, the coach uses a username
      // Also limit per account, so guessing from many addresses at once does not get around the limit.
      if (await lim.count(`login-acct:${login}`) >= o.accountLoginLimit) throw new HttpError(429, 'too_many_attempts', 'Too many wrong passwords for this account. Try again in 15 minutes.');
      const row = await db.get('SELECT * FROM users WHERE email = ?', [login]);
      const ok = await verifyPassword(String(b.password ?? '').slice(0, 200), row ? row.password_hash : DUMMY_HASH);
      if (!row || !ok) {
        await lim.add(`login-ip:${ip}`, 15 * 60 * 1000);
        await lim.add(`login-acct:${login}`, 15 * 60 * 1000);
        throw new HttpError(401, 'bad_credentials', 'Wrong username/email or password.');
      }
      if (row.blocked) throw new HttpError(403, 'blocked', 'This account has been blocked.');
      await lim.clear(`login-ip:${ip}`);
      await lim.clear(`login-acct:${login}`);
      const token = await createSession(db, row.id, SESSION_TTL[row.role]);
      return json(res, 200, {
        token, verification_required: requireVerifiedOn,
        user: { id: row.id, name: row.name, email: row.email, role: row.role, email_verified: row.email_verified },
      });
    }
    if (m === 'POST' && p === '/api/auth/logout') {
      await deleteSession(db, bearer(req));
      return json(res, 200, { ok: true });
    }
    if (m === 'GET' && p === '/api/me') {
      return json(res, 200, { user: await requireUser(req), verification_required: requireVerifiedOn });
    }
    if (m === 'POST' && p === '/api/auth/verify') {
      const id = await consumeEmailToken(db, (await readJson(req)).token, 'verify');
      if (!id) throw new HttpError(400, 'bad_link', 'That link has expired or was already used. Sign in and ask for a new one.');
      await db.run('UPDATE users SET email_verified = 1 WHERE id = ?', [id]);
      return json(res, 200, { ok: true });
    }
    if (m === 'POST' && p === '/api/auth/resend-verification') {
      const user = await requireUser(req);
      if (user.email_verified) return json(res, 200, { ok: true });
      if (await lim.count(`verify:${user.id}`) >= o.forgotPerHour) throw new HttpError(429, 'slow_down', 'We already sent you a few emails. Please check your inbox and spam folder.');
      await lim.add(`verify:${user.id}`, HOUR);
      await sendVerifyEmail(user);
      return json(res, 200, { ok: true });
    }
    if (m === 'POST' && p === '/api/auth/forgot') {
      const ip = clientIp(req);
      const email = normEmail((await readJson(req)).email);
      if (await lim.count(`forgot-ip:${ip}`) >= 10) throw new HttpError(429, 'slow_down', 'Too many requests. Try again later.');
      await lim.add(`forgot-ip:${ip}`, HOUR);
      const row = validEmail(email) ? await db.get("SELECT * FROM users WHERE email = ? AND role = 'customer' AND blocked = 0", [email]) : null;
      if (row && await lim.count(`reset:${row.id}`) < o.forgotPerHour) {
        await lim.add(`reset:${row.id}`, HOUR);
        const token = await createEmailToken(db, row.id, 'reset', RESET_TTL);
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
      const id = await consumeEmailToken(db, b.token, 'reset');
      if (!id) throw new HttpError(400, 'bad_link', 'That link has expired or was already used. Ask for a new one.');
      // they proved they own the inbox, so the address counts as confirmed; everyone is signed out
      await db.batch([
        ["UPDATE users SET password_hash = ?, email_verified = 1 WHERE id = ? AND role = 'customer'", [await hashPassword(password), id]],
        ['DELETE FROM sessions WHERE user_id = ?', [id]],
      ]);
      return json(res, 200, { ok: true });
    }

    // ===== customers (signed in) =====
    if (m === 'POST' && (mt = p.match(/^\/api\/workouts\/(\d+)\/feedback$/))) {
      const user = await requireUser(req);
      requireVerified(user);
      const id = Number(mt[1]);
      if (!(await publishedExists(id))) throw new HttpError(404, 'not_found', 'Workout not found.');
      const b = await readJson(req);
      let rating = null;
      if (b.rating !== undefined && b.rating !== null && b.rating !== '') {
        rating = Number(b.rating);
        if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new HttpError(400, 'invalid', 'Rating must be 1 to 5 stars.');
      }
      const body = text(b.body, 1000, 'Comment');
      if (rating === null && !body) throw new HttpError(400, 'invalid', 'Write a comment or choose a star rating.');
      const since = new Date(Date.now() - HOUR).toISOString();
      if ((await db.get('SELECT COUNT(*) AS n FROM feedback WHERE user_id = ? AND created_at > ?', [user.id, since])).n >= o.feedbackPerHour) {
        throw new HttpError(429, 'slow_down', 'You are posting too fast. Please try again later.');
      }
      if (rating !== null && await db.get('SELECT 1 AS ok FROM feedback WHERE workout_id = ? AND user_id = ? AND rating IS NOT NULL', [id, user.id])) {
        throw new HttpError(409, 'already_reviewed', 'You have already reviewed this workout.');
      }
      const created = new Date().toISOString();
      const r = await db.run('INSERT INTO feedback (workout_id, user_id, rating, body, created_at) VALUES (?,?,?,?,?)', [id, user.id, rating, body, created]);
      return json(res, 201, { feedback: feedbackOut({ id: r.lastInsertRowid, name: user.name, rating, body, created_at: created }), ...(await ratingOf(id)) });
    }
    if (m === 'GET' && p === '/api/wod/download') {
      requireVerified(await requireUser(req));
      const day = today();
      const row = await wodRow(day);
      if (!row) throw new HttpError(404, 'no_wod', 'There is no workout of the day to download yet.');
      const html = await buildWorkoutHtml(await loadWorkout(row), day, files, o.maxEmbedBytes);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': `attachment; filename="${slug(row.title)}-${day}.html"`,
        'Cache-Control': 'no-store',
      });
      return res.end(html);
    }

    // ===== admin only: everything below =====
    if (p.startsWith('/api/admin/')) await requireAdmin(req);

    if (m === 'GET' && p === '/api/admin/workouts') {
      const rows = await db.all('SELECT * FROM workouts ORDER BY updated_at DESC, id DESC');
      return json(res, 200, { workouts: await mapAll(rows, summary) });
    }
    if (m === 'GET' && (mt = p.match(/^\/api\/admin\/workouts\/(\d+)$/))) {
      const row = await db.get('SELECT * FROM workouts WHERE id = ?', [Number(mt[1])]);
      if (!row) throw new HttpError(404, 'not_found', 'Workout not found.');
      return json(res, 200, { workout: await loadWorkout(row) });
    }
    if (m === 'POST' && p === '/api/admin/workouts') {
      const w = await cleanWorkoutChecked(await readJson(req));
      const now = new Date().toISOString();
      const r = await db.run('INSERT INTO workouts (title, description, category, level, duration_min, published, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
        [w.title, w.description, w.category, w.level, w.duration_min, w.published, now, now]);
      const id = r.lastInsertRowid;
      try { if (w.exercises.length) await db.batch(insertExercises(id, w.exercises)); }
      catch (e) { await db.run('DELETE FROM workouts WHERE id = ?', [id]); throw e; } // all or nothing
      return json(res, 201, { workout: await loadWorkout(await db.get('SELECT * FROM workouts WHERE id = ?', [id])) });
    }
    if (m === 'PUT' && (mt = p.match(/^\/api\/admin\/workouts\/(\d+)$/))) {
      const id = Number(mt[1]);
      if (!(await db.get('SELECT 1 AS ok FROM workouts WHERE id = ?', [id]))) throw new HttpError(404, 'not_found', 'Workout not found.');
      const w = await cleanWorkoutChecked(await readJson(req));
      await db.batch([
        ['UPDATE workouts SET title=?, description=?, category=?, level=?, duration_min=?, published=?, updated_at=? WHERE id=?',
          [w.title, w.description, w.category, w.level, w.duration_min, w.published, new Date().toISOString(), id]],
        ['DELETE FROM exercises WHERE workout_id = ?', [id]],
        ...insertExercises(id, w.exercises),
      ]);
      await pruneImages();
      return json(res, 200, { workout: await loadWorkout(await db.get('SELECT * FROM workouts WHERE id = ?', [id])) });
    }
    if (m === 'DELETE' && (mt = p.match(/^\/api\/admin\/workouts\/(\d+)$/))) {
      const id = Number(mt[1]);
      // explicit deletes (not only ON DELETE CASCADE) so this behaves the same on every database host
      const [, , , gone] = await db.batch([
        ['DELETE FROM exercises WHERE workout_id = ?', [id]],
        ['DELETE FROM wod_schedule WHERE workout_id = ?', [id]],
        ['DELETE FROM feedback WHERE workout_id = ?', [id]],
        ['DELETE FROM workouts WHERE id = ?', [id]],
      ]);
      if (!gone.changes) throw new HttpError(404, 'not_found', 'Workout not found.');
      await pruneImages();
      return json(res, 200, { ok: true });
    }

    if (m === 'POST' && p === '/api/admin/upload') {
      const buf = await readBody(req, MAX_IMAGE);
      const kind = IMAGE_SNIFF.find(([, , test]) => test(buf));
      if (!kind) throw new HttpError(400, 'bad_image', 'Upload a PNG, JPG, WebP or GIF image (max 4 MB).');
      return json(res, 201, { file: await files.put(buf, kind[0], kind[1]) });
    }

    // donation link + message
    if (m === 'GET' && p === '/api/admin/donate') return json(res, 200, await donateConfig());
    if (m === 'PUT' && p === '/api/admin/donate') {
      const d = cleanDonate(await readJson(req));
      const put = 'INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value';
      await db.batch([
        [put, ['donate_url', d.url]], [put, ['donate_amount_url', d.amount_url]],
        [put, ['donate_message', d.message]], [put, ['donate_amounts', JSON.stringify(d.amounts)]],
      ]);
      return json(res, 200, await donateConfig());
    }

    // workout of the day schedule
    if (m === 'GET' && p === '/api/admin/wod') {
      const from = addDays(today(), -7);
      const rows = await db.all('SELECT s.day, w.id AS workout_id, w.title, w.published FROM wod_schedule s JOIN workouts w ON w.id = s.workout_id WHERE s.day >= ? ORDER BY s.day', [from]);
      return json(res, 200, { today: today(), schedule: rows.map((r) => ({ ...r, published: !!r.published })) });
    }
    if (m === 'PUT' && (mt = p.match(/^\/api\/admin\/wod\/([^/]+)$/))) {
      if (!validDay(mt[1])) throw new HttpError(400, 'invalid', 'Pick a valid date.');
      const b = await readJson(req);
      if (!(await db.get('SELECT 1 AS ok FROM workouts WHERE id = ?', [Number(b.workout_id)]))) throw new HttpError(400, 'invalid', 'Pick a workout.');
      await db.run('INSERT INTO wod_schedule (day, workout_id) VALUES (?,?) ON CONFLICT(day) DO UPDATE SET workout_id = excluded.workout_id', [mt[1], Number(b.workout_id)]);
      return json(res, 200, { ok: true });
    }
    if (m === 'DELETE' && (mt = p.match(/^\/api\/admin\/wod\/([^/]+)$/))) {
      if (!validDay(mt[1])) throw new HttpError(400, 'invalid', 'Pick a valid date.');
      await db.run('DELETE FROM wod_schedule WHERE day = ?', [mt[1]]);
      return json(res, 200, { ok: true });
    }

    // moderation: comments and reviews
    if (m === 'GET' && p === '/api/admin/feedback') {
      const rows = await db.all(
        `SELECT f.id, f.rating, f.body, f.created_at, w.title AS workout, u.name, u.email, u.id AS user_id
         FROM feedback f JOIN workouts w ON w.id = f.workout_id JOIN users u ON u.id = f.user_id ORDER BY f.id DESC LIMIT 200`);
      return json(res, 200, { feedback: rows });
    }
    if (m === 'DELETE' && (mt = p.match(/^\/api\/admin\/feedback\/(\d+)$/))) {
      const r = await db.run('DELETE FROM feedback WHERE id = ?', [Number(mt[1])]);
      if (!r.changes) throw new HttpError(404, 'not_found', 'Not found.');
      return json(res, 200, { ok: true });
    }

    // customers
    if (m === 'GET' && p === '/api/admin/users') {
      const rows = await db.all(
        `SELECT u.id, u.name, u.email, u.role, u.blocked, u.created_at, (SELECT COUNT(*) FROM feedback f WHERE f.user_id = u.id) AS feedback_count
         FROM users u ORDER BY u.id DESC LIMIT 500`);
      return json(res, 200, { users: rows.map((r) => ({ ...r, blocked: !!r.blocked })) });
    }
    if (m === 'PUT' && (mt = p.match(/^\/api\/admin\/users\/(\d+)$/))) {
      const id = Number(mt[1]);
      const target = await db.get('SELECT * FROM users WHERE id = ?', [id]);
      if (!target) throw new HttpError(404, 'not_found', 'Not found.');
      if (target.role === 'admin') throw new HttpError(400, 'invalid', 'The admin account cannot be blocked.');
      const blocked = (await readJson(req)).blocked ? 1 : 0;
      await db.batch([
        ['UPDATE users SET blocked = ? WHERE id = ?', [blocked, id]],
        ...(blocked ? [['DELETE FROM sessions WHERE user_id = ?', [id]]] : []),
      ]);
      return json(res, 200, { ok: true });
    }
    if (m === 'DELETE' && (mt = p.match(/^\/api\/admin\/users\/(\d+)$/))) {
      const target = await db.get('SELECT * FROM users WHERE id = ?', [Number(mt[1])]);
      if (!target) throw new HttpError(404, 'not_found', 'Not found.');
      if (target.role === 'admin') throw new HttpError(400, 'invalid', 'The admin account cannot be deleted.');
      // their sessions, links, comments and reviews go with them
      await db.batch([
        ['DELETE FROM sessions WHERE user_id = ?', [target.id]],
        ['DELETE FROM email_tokens WHERE user_id = ?', [target.id]],
        ['DELETE FROM feedback WHERE user_id = ?', [target.id]],
        ['DELETE FROM users WHERE id = ?', [target.id]],
      ]);
      return json(res, 200, { ok: true });
    }

    throw new HttpError(404, 'not_found', 'Not found.');
  }

  // Pictures stored on local disk are served here; Vercel Blob pictures have their own public addresses.
  function serveUpload(res, name) {
    if (files.kind !== 'disk' || !LOCAL_NAME.test(name)) throw new HttpError(404, 'not_found', 'Not found.');
    const file = path.join(files.root, name);
    let stat;
    try { stat = fs.statSync(file); } catch { throw new HttpError(404, 'not_found', 'Not found.'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(name)],
      'Content-Length': stat.size,
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    fs.createReadStream(file).pipe(res);
  }

  // The request handler: (req, res) as in Node's http module, which is also what Vercel passes to functions.
  async function handle(req, res, pathOverride) {
    // This server only returns data, so lock the responses down completely.
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      await ready;
      const url = new URL(req.url, 'http://localhost');
      if (pathOverride) url.pathname = pathOverride;
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
  }

  return { handle, ready, close: async () => { try { await ready; } catch { /* ignore */ } db?.close(); } };
}

// Local / Docker / Fly: a plain Node HTTP server around the handler.
export function createApp(opts = {}) {
  const h = createHandler(opts);
  const server = http.createServer((req, res) => h.handle(req, res));
  return { server, ready: h.ready, close: () => new Promise((r) => server.close(async () => { await h.close(); r(); })) };
}
