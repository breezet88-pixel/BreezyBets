// FitLibrary server: public read-only workout API + password-protected admin API.
// Plain Node, no dependencies. Data lives in SQLite (node:sqlite); uploaded exercise
// images live as files in uploadDir.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, '..', 'public');
const MAX_JSON = 256 * 1024;
const MAX_IMAGE = 5 * 1024 * 1024;
const SESSION_MS = 12 * 60 * 60 * 1000;
const IMAGE_NAME = /^[a-f0-9]{32}\.(png|jpg|webp|gif)$/;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
};

// Detect the real image type from magic bytes; never trust the client's content-type.
const IMAGE_SNIFF = [
  ['png', (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['jpg', (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['webp', (b) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP'],
  ['gif', (b) => b.length > 6 && b.toString('latin1', 0, 4) === 'GIF8'],
];

class HttpError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  level TEXT NOT NULL DEFAULT '',
  duration_min INTEGER,
  published INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS exercises (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workout_id INTEGER NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  muscles TEXT NOT NULL DEFAULT '',
  equipment TEXT NOT NULL DEFAULT '',
  sets TEXT NOT NULL DEFAULT '',
  reps TEXT NOT NULL DEFAULT '',
  rest_sec INTEGER,
  cues TEXT NOT NULL DEFAULT '',
  image TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS exercises_workout ON exercises(workout_id, position);
`;

export function createApp({
  dbPath = './data/fitlibrary.db',
  uploadDir = './data/uploads',
  adminPassword = process.env.ADMIN_PASSWORD,
  secret = process.env.SESSION_SECRET,
  secureCookies = process.env.COOKIE_SECURE === 'true',
  trustProxy = process.env.TRUST_PROXY === 'true',
  loginLimit = 8,
} = {}) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  fs.mkdirSync(uploadDir, { recursive: true });
  const uploadRoot = path.resolve(uploadDir);

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);

  const sessionSecret = secret || crypto.randomBytes(32).toString('hex');
  const passwordHash = adminPassword ? sha256(adminPassword) : null;
  const attempts = new Map(); // ip -> { count, resetAt }

  // ---------- helpers ----------
  function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest(); }
  function sign(v) { return crypto.createHmac('sha256', sessionSecret).update(v).digest('hex'); }
  function safeEqual(a, b) { return a.length === b.length && crypto.timingSafeEqual(a, b); }

  function clientIp(req) {
    if (trustProxy) {
      const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (xf) return xf;
    }
    return req.socket.remoteAddress || 'unknown';
  }

  function parseCookies(req) {
    const out = {};
    for (const part of String(req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    return out;
  }

  function isAdmin(req) {
    const tok = parseCookies(req).fl_admin;
    if (!tok) return false;
    const [exp, mac] = tok.split('.');
    if (!exp || !mac || !/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
    const want = Buffer.from(sign(exp));
    const got = Buffer.from(mac);
    return safeEqual(want, got);
  }

  function requireAdmin(req) {
    if (!isAdmin(req)) throw new HttpError(401, 'unauthorized', 'Please sign in.');
  }

  function json(res, status, body, headers = {}) {
    const data = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(data);
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
    try { return JSON.parse(buf.toString('utf8') || '{}'); }
    catch { throw new HttpError(400, 'bad_json', 'Request body is not valid JSON.'); }
  }

  // ---------- validation ----------
  function text(v, max, label, required = false) {
    if (v === undefined || v === null) v = '';
    if (typeof v !== 'string' && typeof v !== 'number') throw new HttpError(400, 'invalid', `${label} must be text.`);
    const s = String(v).trim();
    if (required && !s) throw new HttpError(400, 'invalid', `${label} is required.`);
    if (s.length > max) throw new HttpError(400, 'invalid', `${label} is too long (max ${max} characters).`);
    return s;
  }

  function intOrNull(v, min, max, label) {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, 'invalid', `${label} must be a whole number from ${min} to ${max}.`);
    return n;
  }

  function cleanWorkout(body) {
    if (!body || typeof body !== 'object') throw new HttpError(400, 'invalid', 'Missing workout.');
    const exercisesIn = body.exercises ?? [];
    if (!Array.isArray(exercisesIn) || exercisesIn.length > 100) throw new HttpError(400, 'invalid', 'A workout can have up to 100 exercises.');
    const w = {
      title: text(body.title, 120, 'Title', true),
      description: text(body.description, 2000, 'Description'),
      category: text(body.category, 40, 'Category'),
      level: text(body.level, 40, 'Level'),
      duration_min: intOrNull(body.duration_min, 1, 600, 'Duration'),
      published: body.published ? 1 : 0,
      exercises: exercisesIn.map((e, i) => {
        const n = `Exercise ${i + 1}`;
        if (!e || typeof e !== 'object') throw new HttpError(400, 'invalid', `${n} is not valid.`);
        const image = text(e.image, 80, `${n} image`);
        if (image) {
          if (!IMAGE_NAME.test(image) || !fs.existsSync(path.join(uploadRoot, image))) {
            throw new HttpError(400, 'invalid', `${n} image was not found. Upload it again.`);
          }
        }
        return {
          name: text(e.name, 120, `${n} name`, true),
          muscles: text(e.muscles, 120, `${n} muscles`),
          equipment: text(e.equipment, 120, `${n} equipment`),
          sets: text(e.sets, 20, `${n} sets`),
          reps: text(e.reps, 40, `${n} reps`),
          rest_sec: intOrNull(e.rest_sec, 0, 3600, `${n} rest`),
          cues: text(e.cues, 1500, `${n} form cues`),
          image,
        };
      }),
    };
    return w;
  }

  // ---------- data access ----------
  const exercisesFor = db.prepare('SELECT id, name, muscles, equipment, sets, reps, rest_sec, cues, image FROM exercises WHERE workout_id = ? ORDER BY position');

  function loadWorkout(row) {
    return {
      id: row.id, title: row.title, description: row.description, category: row.category,
      level: row.level, duration_min: row.duration_min, published: !!row.published,
      updated_at: row.updated_at, exercises: exercisesFor.all(row.id).map((e) => ({ ...e })),
    };
  }

  function summary(row) {
    const ex = exercisesFor.all(row.id);
    return {
      id: row.id, title: row.title, description: row.description, category: row.category,
      level: row.level, duration_min: row.duration_min, published: !!row.published,
      updated_at: row.updated_at, exercise_count: ex.length,
      cover: (ex.find((e) => e.image) || {}).image || '',
    };
  }

  function writeExercises(workoutId, list) {
    const ins = db.prepare('INSERT INTO exercises (workout_id, position, name, muscles, equipment, sets, reps, rest_sec, cues, image) VALUES (?,?,?,?,?,?,?,?,?,?)');
    list.forEach((e, i) => ins.run(workoutId, i, e.name, e.muscles, e.equipment, e.sets, e.reps, e.rest_sec, e.cues, e.image));
  }

  function inTransaction(fn) {
    db.exec('BEGIN');
    try { const r = fn(); db.exec('COMMIT'); return r; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  // ---------- API ----------
  async function api(req, res, url) {
    const p = url.pathname;
    const m = req.method;
    let mt;

    // ---- public (read only) ----
    if (m === 'GET' && p === '/api/workouts') {
      const rows = db.prepare('SELECT * FROM workouts WHERE published = 1 ORDER BY updated_at DESC, id DESC').all();
      return json(res, 200, { workouts: rows.map(summary) }, { 'Cache-Control': 'no-cache' });
    }
    if (m === 'GET' && (mt = p.match(/^\/api\/workouts\/(\d+)$/))) {
      const row = db.prepare('SELECT * FROM workouts WHERE id = ? AND published = 1').get(Number(mt[1]));
      if (!row) throw new HttpError(404, 'not_found', 'Workout not found.');
      return json(res, 200, { workout: loadWorkout(row) }, { 'Cache-Control': 'no-cache' });
    }

    // ---- admin auth ----
    if (m === 'POST' && p === '/api/admin/login') {
      if (!passwordHash) throw new HttpError(503, 'admin_disabled', 'Admin is disabled: set the ADMIN_PASSWORD environment variable.');
      const ip = clientIp(req);
      const now = Date.now();
      let a = attempts.get(ip);
      if (!a || a.resetAt < now) { a = { count: 0, resetAt: now + 15 * 60 * 1000 }; attempts.set(ip, a); }
      if (a.count >= loginLimit) throw new HttpError(429, 'too_many_attempts', 'Too many attempts. Try again in 15 minutes.');
      const body = await readJson(req);
      if (!safeEqual(sha256(body.password ?? ''), passwordHash)) {
        a.count++;
        throw new HttpError(401, 'bad_password', 'Wrong password.');
      }
      attempts.delete(ip);
      const exp = String(now + SESSION_MS);
      const cookie = `fl_admin=${exp}.${sign(exp)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secureCookies ? '; Secure' : ''}`;
      return json(res, 200, { ok: true }, { 'Set-Cookie': cookie });
    }
    if (m === 'POST' && p === '/api/admin/logout') {
      return json(res, 200, { ok: true }, { 'Set-Cookie': `fl_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookies ? '; Secure' : ''}` });
    }
    if (m === 'GET' && p === '/api/admin/me') {
      return json(res, 200, { admin: isAdmin(req), enabled: !!passwordHash });
    }

    // ---- admin: workouts ----
    if (p.startsWith('/api/admin/')) requireAdmin(req);

    if (m === 'GET' && p === '/api/admin/workouts') {
      const rows = db.prepare('SELECT * FROM workouts ORDER BY updated_at DESC, id DESC').all();
      return json(res, 200, { workouts: rows.map(summary) });
    }
    if (m === 'GET' && (mt = p.match(/^\/api\/admin\/workouts\/(\d+)$/))) {
      const row = db.prepare('SELECT * FROM workouts WHERE id = ?').get(Number(mt[1]));
      if (!row) throw new HttpError(404, 'not_found', 'Workout not found.');
      return json(res, 200, { workout: loadWorkout(row) });
    }
    if (m === 'POST' && p === '/api/admin/workouts') {
      const w = cleanWorkout(await readJson(req));
      const now = new Date().toISOString();
      const id = inTransaction(() => {
        const r = db.prepare('INSERT INTO workouts (title, description, category, level, duration_min, published, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
          .run(w.title, w.description, w.category, w.level, w.duration_min, w.published, now, now);
        const wid = Number(r.lastInsertRowid);
        writeExercises(wid, w.exercises);
        return wid;
      });
      return json(res, 201, { workout: loadWorkout(db.prepare('SELECT * FROM workouts WHERE id = ?').get(id)) });
    }
    if (m === 'PUT' && (mt = p.match(/^\/api\/admin\/workouts\/(\d+)$/))) {
      const id = Number(mt[1]);
      if (!db.prepare('SELECT 1 FROM workouts WHERE id = ?').get(id)) throw new HttpError(404, 'not_found', 'Workout not found.');
      const w = cleanWorkout(await readJson(req));
      inTransaction(() => {
        db.prepare('UPDATE workouts SET title=?, description=?, category=?, level=?, duration_min=?, published=?, updated_at=? WHERE id=?')
          .run(w.title, w.description, w.category, w.level, w.duration_min, w.published, new Date().toISOString(), id);
        db.prepare('DELETE FROM exercises WHERE workout_id = ?').run(id);
        writeExercises(id, w.exercises);
      });
      return json(res, 200, { workout: loadWorkout(db.prepare('SELECT * FROM workouts WHERE id = ?').get(id)) });
    }
    if (m === 'DELETE' && (mt = p.match(/^\/api\/admin\/workouts\/(\d+)$/))) {
      const r = db.prepare('DELETE FROM workouts WHERE id = ?').run(Number(mt[1]));
      if (!r.changes) throw new HttpError(404, 'not_found', 'Workout not found.');
      return json(res, 200, { ok: true });
    }

    // ---- admin: image upload (raw bytes in the body) ----
    if (m === 'POST' && p === '/api/admin/upload') {
      const buf = await readBody(req, MAX_IMAGE);
      const kind = IMAGE_SNIFF.find(([, test]) => test(buf));
      if (!kind) throw new HttpError(400, 'bad_image', 'Upload a PNG, JPG, WebP or GIF image (max 5 MB).');
      const name = `${crypto.randomBytes(16).toString('hex')}.${kind[0]}`;
      fs.writeFileSync(path.join(uploadRoot, name), buf);
      return json(res, 201, { file: name });
    }

    throw new HttpError(404, 'not_found', 'Not found.');
  }

  // ---------- static ----------
  function sendFile(res, file, extraHeaders = {}) {
    let stat;
    try { stat = fs.statSync(file); } catch { throw new HttpError(404, 'not_found', 'Not found.'); }
    if (!stat.isFile()) throw new HttpError(404, 'not_found', 'Not found.');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      ...extraHeaders,
    });
    fs.createReadStream(file).pipe(res);
  }

  function serveUpload(res, name) {
    if (!IMAGE_NAME.test(name)) throw new HttpError(404, 'not_found', 'Not found.');
    sendFile(res, path.join(uploadRoot, name), { 'Cache-Control': 'public, max-age=31536000, immutable' });
  }

  function serveStatic(res, pathname) {
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { throw new HttpError(400, 'bad_path', 'Bad path.'); }
    if (rel === '/') rel = '/index.html';
    if (rel === '/admin') rel = '/admin.html';
    const file = path.join(PUBLIC_DIR, path.normalize(rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(404, 'not_found', 'Not found.');
    sendFile(res, file, { 'Cache-Control': 'no-cache' });
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; " +
      "manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed', 'Method not allowed.');
      if (url.pathname.startsWith('/uploads/')) return serveUpload(res, url.pathname.slice('/uploads/'.length));
      return serveStatic(res, url.pathname);
    } catch (e) {
      if (res.headersSent) return res.destroy();
      if (e instanceof HttpError) return json(res, e.status, { error: e.code, message: e.message });
      console.error(e);
      return json(res, 500, { error: 'server_error', message: 'Something went wrong.' });
    }
  });

  return { server, db, close: () => new Promise((r) => server.close(() => { db.close(); r(); })) };
}
