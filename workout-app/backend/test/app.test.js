import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/server.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const WEB = 'http://localhost:8080';

let app, base, uploadDir, clock = new Date('2026-11-20T10:00:00Z');

// tiny client: pass a token to act as that person
async function call(method, url, body, token, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (token) headers.authorization = `Bearer ${token}`;
  let payload = body;
  if (body !== undefined && !Buffer.isBuffer(body)) { payload = JSON.stringify(body); headers['content-type'] = 'application/json'; }
  const res = await fetch(base + url, { method, headers, body: payload });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, body: ct.includes('json') ? await res.json() : await res.text() };
}

async function signIn(email, password) {
  const r = await call('POST', '/api/auth/login', { email, password });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.token;
}
async function register(name, email, password = 'longenough1') {
  const r = await call('POST', '/api/auth/register', { name, email, password });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}

const outbox = [];
const mailer = { real: false, async send(m) { outbox.push(m); } };
const tokenIn = (mail) => /token=([A-Za-z0-9_-]+)/.exec(mail.text)[1];

let admin, ann, ben, workoutId, imageFile;

before(async () => {
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-test-'));
  app = createApp({
    dbPath: ':memory:', uploadDir, corsOrigins: [WEB], adminUsername: 'TestCoach', adminPassword: 'test-coach-pass', mailer,
    now: () => clock, loginLimit: 100, registerLimit: 100, feedbackPerHour: 4, pruneGraceMs: 0,
  });
  await app.ready;
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  admin = await signIn('TestCoach', 'test-coach-pass');
  ann = (await register('Ann', 'ann@example.com')).token;
  ben = (await register('Ben', 'ben@example.com')).token;
});

after(async () => {
  await app.close();
  fs.rmSync(uploadDir, { recursive: true, force: true });
});

test('API only: no web pages, locked-down headers, CORS only for the front end', async () => {
  const root = await call('GET', '/');
  assert.equal(root.status, 404);
  assert.match(root.headers.get('content-security-policy'), /default-src 'none'/);
  const ok = await call('GET', '/api/health', undefined, null, { origin: WEB });
  assert.equal(ok.headers.get('access-control-allow-origin'), WEB);
  const evil = await call('GET', '/api/health', undefined, null, { origin: 'https://evil.example' });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
  const pre = await fetch(base + '/api/admin/workouts', { method: 'OPTIONS', headers: { origin: WEB, 'access-control-request-method': 'POST' } });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('access-control-allow-headers'), /Authorization/);
});

test('admin: only you can edit. Anonymous and customers are refused everywhere', async () => {
  const adminCalls = [
    ['GET', '/api/admin/workouts'], ['POST', '/api/admin/workouts', { title: 'x' }], ['PUT', '/api/admin/workouts/1', { title: 'x' }],
    ['DELETE', '/api/admin/workouts/1'], ['POST', '/api/admin/upload', PNG], ['GET', '/api/admin/wod'], ['PUT', '/api/admin/wod/2026-11-20', { workout_id: 1 }],
    ['DELETE', '/api/admin/wod/2026-11-20'], ['GET', '/api/admin/feedback'], ['DELETE', '/api/admin/feedback/1'],
    ['GET', '/api/admin/users'], ['PUT', '/api/admin/users/2', { blocked: true }], ['DELETE', '/api/admin/users/2'],
  ];
  for (const [m, u, b] of adminCalls) {
    assert.equal((await call(m, u, b)).status, 401, `anonymous ${m} ${u}`);
    assert.equal((await call(m, u, b, ann)).status, 403, `customer ${m} ${u}`);
  }
  assert.equal((await call('GET', '/api/admin/workouts', undefined, admin)).status, 200);
});

test('nobody can register as admin or take over the admin email', async () => {
  const r = await call('POST', '/api/auth/register', { name: 'Eve', email: 'eve@example.com', password: 'longenough1', role: 'admin' });
  assert.equal(r.body.user.role, 'customer');
  assert.equal((await call('GET', '/api/admin/users', undefined, r.body.token)).status, 403);
  // the coach name is not an email address, so it can never be registered by a customer
  assert.equal((await call('POST', '/api/auth/register', { name: 'X', email: 'TestCoach', password: 'longenough1' })).status, 400);
});

test('coach signs in with the username (any capitalisation) and password; nothing else works', async () => {
  const r = await call('POST', '/api/auth/login', { login: 'testcoach', password: 'test-coach-pass' });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.role, 'admin');
  assert.equal((await call('GET', '/api/admin/workouts', undefined, r.body.token)).status, 200);
  assert.equal((await call('POST', '/api/auth/login', { login: 'TestCoach', password: 'wrong-pass' })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { login: 'admin', password: 'test-coach-pass' })).status, 401);
});

test('guessing the coach password from many addresses is stopped by a per-account lockout', async () => {
  const locked = createApp({ dbPath: ':memory:', uploadDir, adminUsername: 'TestCoach', adminPassword: 'test-coach-pass', mailer, trustProxy: true, loginLimit: 1000, accountLoginLimit: 3 });
  await locked.ready;
  await new Promise((r) => locked.server.listen(0, r));
  const saved = base;
  base = `http://localhost:${locked.server.address().port}`;
  try {
    for (let i = 0; i < 3; i++) {
      const r = await call('POST', '/api/auth/login', { login: 'TestCoach', password: String(1000 + i) }, null, { 'x-forwarded-for': `10.0.0.${i}` });
      assert.equal(r.status, 401);
    }
    // a different address, and even the right password: still locked
    const r = await call('POST', '/api/auth/login', { login: 'TestCoach', password: 'test-coach-pass' }, null, { 'x-forwarded-for': '10.0.0.99' });
    assert.equal(r.status, 429);
  } finally { base = saved; await locked.close(); }
});

test('registration and login validation', async () => {
  assert.equal((await call('POST', '/api/auth/register', { name: 'A', email: 'nope', password: 'longenough1' })).status, 400);
  assert.equal((await call('POST', '/api/auth/register', { name: 'A', email: 'a@b.co', password: 'short' })).status, 400);
  assert.equal((await call('POST', '/api/auth/register', { name: '', email: 'a@b.co', password: 'longenough1' })).status, 400);
  assert.equal((await call('POST', '/api/auth/login', { email: 'ann@example.com', password: 'wrong' })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { email: 'nobody@example.com', password: 'wrong' })).status, 401);
});

test('wrong-password attempts are rate limited', async () => {
  const limited = createApp({ dbPath: ':memory:', uploadDir, loginLimit: 3 });
  await limited.ready;
  await new Promise((r) => limited.server.listen(0, r));
  const saved = base;
  base = `http://localhost:${limited.server.address().port}`;
  try {
    for (let i = 0; i < 3; i++) assert.equal((await call('POST', '/api/auth/login', { email: 'x@example.com', password: 'wrong' })).status, 401);
    assert.equal((await call('POST', '/api/auth/login', { email: 'x@example.com', password: 'wrong' })).status, 429);
  } finally { base = saved; await limited.close(); }
});

test('admin builds a workout, with a picture; drafts are hidden from customers', async () => {
  assert.equal((await call('POST', '/api/admin/upload', Buffer.from('<script>alert(1)</script>'), admin)).status, 400);
  const up = await call('POST', '/api/admin/upload', PNG, admin);
  assert.equal(up.status, 201);
  imageFile = up.body.file;
  assert.equal((await call('POST', '/api/admin/workouts', { title: '' }, admin)).status, 400);
  assert.equal((await call('POST', '/api/admin/workouts', { title: 'A', exercises: [{ name: 'Squat', image: '../../x.png' }] }, admin)).status, 400);
  const c = await call('POST', '/api/admin/workouts', {
    title: 'Full Body <b>Starter</b>', category: 'Strength', level: 'Beginner', duration_min: 30, published: false,
    exercises: [{ name: 'Goblet Squat', muscles: 'Quads', sets: '3', reps: '10', rest_sec: 60, cues: 'Chest up', image: imageFile }, { name: 'Push-up' }],
  }, admin);
  assert.equal(c.status, 201);
  workoutId = c.body.workout.id;
  assert.deepEqual((await call('GET', '/api/workouts')).body.workouts, []);
  assert.equal((await call('GET', `/api/workouts/${workoutId}`)).status, 404);
  assert.equal((await call('POST', `/api/workouts/${workoutId}/feedback`, { body: 'hi' }, ann)).status, 404);
  const w = c.body.workout;
  const pub = await call('PUT', `/api/admin/workouts/${workoutId}`, { ...w, published: true }, admin);
  assert.equal(pub.status, 200);
  const list = (await call('GET', '/api/workouts')).body.workouts;
  assert.equal(list.length, 1);
  assert.equal(list[0].cover, imageFile);
  const img = await fetch(`${base}/uploads/${imageFile}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('access-control-allow-origin'), '*');
  assert.equal((await fetch(`${base}/uploads/..%2f..%2fserver%2fserver.js`)).status, 404);
});

test('workout of the day: shown to all, only today, download needs sign-in', async () => {
  // nothing scheduled yet
  assert.equal((await call('GET', '/api/wod')).body.workout, null);
  assert.equal((await call('GET', '/api/wod/download', undefined, ann)).status, 404);
  // schedule for tomorrow: not visible today
  assert.equal((await call('PUT', '/api/admin/wod/2026-11-21', { workout_id: workoutId }, admin)).status, 200);
  assert.equal((await call('GET', '/api/wod')).body.workout, null);
  assert.equal((await call('PUT', '/api/admin/wod/not-a-date', { workout_id: workoutId }, admin)).status, 400);
  assert.equal((await call('PUT', '/api/admin/wod/2026-11-20', { workout_id: 9999 }, admin)).status, 400);
  // today
  assert.equal((await call('PUT', '/api/admin/wod/2026-11-20', { workout_id: workoutId }, admin)).status, 200);
  const wod = (await call('GET', '/api/wod')).body;
  assert.equal(wod.day, '2026-11-20');
  assert.equal(wod.workout.id, workoutId);
  // download: anonymous refused, customer gets a file with the picture embedded and HTML escaped
  assert.equal((await call('GET', '/api/wod/download')).status, 401);
  const dl = await call('GET', '/api/wod/download', undefined, ann);
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition'), /^attachment; filename="full-body-b-starter-b-2026-11-20\.html"$/);
  assert.match(dl.body, /data:image\/png;base64,/);
  assert.match(dl.body, /Full Body &lt;b&gt;Starter&lt;\/b&gt;/);
  assert.ok(!dl.body.includes('<b>Starter'));
  // the Africa/Johannesburg day rolls over at 22:00 UTC
  clock = new Date('2026-11-20T22:30:00Z');
  assert.equal((await call('GET', '/api/wod')).body.day, '2026-11-21');
  clock = new Date('2026-11-20T10:00:00Z');
  // an unpublished workout is never the WOD
  const w = (await call('GET', `/api/admin/workouts/${workoutId}`, undefined, admin)).body.workout;
  await call('PUT', `/api/admin/workouts/${workoutId}`, { ...w, published: false }, admin);
  assert.equal((await call('GET', '/api/wod')).body.workout, null);
  assert.equal((await call('GET', '/api/wod/download', undefined, ann)).status, 404);
  await call('PUT', `/api/admin/workouts/${workoutId}`, { ...w, published: true }, admin);
  // admin sees the schedule and can remove an entry
  assert.equal((await call('GET', '/api/admin/wod', undefined, admin)).body.schedule.length, 2);
  assert.equal((await call('DELETE', '/api/admin/wod/2026-11-21', undefined, admin)).status, 200);
});

test('customers can add comments and reviews, nothing else', async () => {
  const url = `/api/workouts/${workoutId}/feedback`;
  assert.equal((await call('POST', url, { rating: 5 })).status, 401);
  assert.equal((await call('POST', url, {}, ann)).status, 400);
  assert.equal((await call('POST', url, { rating: 6 }, ann)).status, 400);
  assert.equal((await call('POST', url, { rating: 1.5 }, ann)).status, 400);
  assert.equal((await call('POST', url, { body: 'x'.repeat(1001) }, ann)).status, 400);

  const review = await call('POST', url, { rating: 5, body: 'Loved it <script>alert(1)</script>' }, ann);
  assert.equal(review.status, 201);
  assert.equal(review.body.rating_count, 1);
  assert.equal((await call('POST', url, { rating: 4 }, ann)).status, 409, 'one rating per customer');
  assert.equal((await call('POST', url, { body: 'Another comment, no rating' }, ann)).status, 201, 'but extra comments are fine');
  await call('POST', url, { rating: 4 }, ben);

  const pub = (await call('GET', url)).body;
  assert.equal(pub.feedback.length, 3);
  assert.equal(pub.rating_avg, 4.5);
  assert.equal(pub.you_rated, false);
  assert.equal(pub.feedback[0].email, undefined, 'emails are never public');
  assert.equal((await call('GET', url, undefined, ann)).body.you_rated, true);
  assert.equal((await call('GET', '/api/workouts')).body.workouts[0].rating_avg, 4.5);

  // customers cannot edit or delete (no such routes for them)
  const id = pub.feedback[0].id;
  assert.equal((await call('DELETE', `/api/admin/feedback/${id}`, undefined, ann)).status, 403);
  assert.equal((await call('PUT', `/api/workouts/${workoutId}/feedback`, { body: 'x' }, ann)).status, 404);
  assert.equal((await call('DELETE', `/api/workouts/${workoutId}`, undefined, ann)).status, 404);
  assert.equal((await call('PUT', `/api/admin/workouts/${workoutId}`, { title: 'hacked' }, ann)).status, 403);
});

test('posting too fast is limited', async () => {
  const url = `/api/workouts/${workoutId}/feedback`;
  const cat = (await register('Cat', 'cat@example.com')).token;
  for (let i = 0; i < 4; i++) assert.equal((await call('POST', url, { body: `c${i}` }, cat)).status, 201);
  assert.equal((await call('POST', url, { body: 'one too many' }, cat)).status, 429);
});

test('admin moderates: delete a comment, block and delete a customer', async () => {
  const fb = (await call('GET', '/api/admin/feedback', undefined, admin)).body.feedback;
  assert.ok(fb.length >= 3 && fb[0].email);
  assert.equal((await call('DELETE', `/api/admin/feedback/${fb[0].id}`, undefined, admin)).status, 200);

  const users = (await call('GET', '/api/admin/users', undefined, admin)).body.users;
  const benRow = users.find((u) => u.email === 'ben@example.com');
  const adminRow = users.find((u) => u.role === 'admin');
  assert.equal((await call('PUT', `/api/admin/users/${adminRow.id}`, { blocked: true }, admin)).status, 400);
  assert.equal((await call('DELETE', `/api/admin/users/${adminRow.id}`, undefined, admin)).status, 400);

  // blocking ends their session at once and stops new sign-ins
  assert.equal((await call('PUT', `/api/admin/users/${benRow.id}`, { blocked: true }, admin)).status, 200);
  assert.equal((await call('GET', '/api/me', undefined, ben)).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { email: 'ben@example.com', password: 'longenough1' })).status, 403);
  assert.equal((await call('PUT', `/api/admin/users/${benRow.id}`, { blocked: false }, admin)).status, 200);

  // deleting a customer removes their reviews too
  const before = (await call('GET', `/api/workouts/${workoutId}/feedback`)).body.rating_count;
  assert.equal((await call('DELETE', `/api/admin/users/${benRow.id}`, undefined, admin)).status, 200);
  assert.equal((await call('GET', `/api/workouts/${workoutId}/feedback`)).body.rating_count, before - 1);
});

test('admin removes things: removed pictures are deleted, deleting a workout cleans up', async () => {
  const w = (await call('GET', `/api/admin/workouts/${workoutId}`, undefined, admin)).body.workout;
  // drop the picture from the exercise
  await call('PUT', `/api/admin/workouts/${workoutId}`, { ...w, exercises: w.exercises.map((e) => ({ ...e, image: '' })) }, admin);
  assert.equal((await fetch(`${base}/uploads/${imageFile}`)).status, 404, 'unused picture is removed from disk');
  assert.equal((await call('DELETE', `/api/admin/workouts/${workoutId}`, undefined, admin)).status, 200);
  assert.equal((await call('GET', '/api/wod')).body.workout, null);
  assert.deepEqual((await call('GET', '/api/admin/wod', undefined, admin)).body.schedule, [], 'schedule entries go with the workout');
  assert.equal((await call('GET', `/api/workouts/${workoutId}/feedback`)).status, 404);
});

test('logout ends the session; forged tokens are rejected', async () => {
  assert.equal((await call('GET', '/api/me', undefined, ann)).status, 200);
  await call('POST', '/api/auth/logout', {}, ann);
  assert.equal((await call('GET', '/api/me', undefined, ann)).status, 401);
  assert.equal((await call('GET', '/api/me', undefined, 'A'.repeat(43))).status, 401);
});

// ---- email verification and password reset ----
async function withApp(extra, fn) {
  const a = createApp({ dbPath: ':memory:', uploadDir, adminUsername: 'TestCoach', adminPassword: 'test-coach-pass', mailer, appUrl: WEB, now: () => clock, ...extra });
  await a.ready;
  await new Promise((r) => a.server.listen(0, r));
  const saved = base;
  base = `http://localhost:${a.server.address().port}`;
  try { await fn(); } finally { base = saved; await a.close(); }
}

test('email verification: unverified customers cannot post or download until they click the link', async () => {
  await withApp({ requireVerified: true }, async () => {
    const coach = await signIn('TestCoach', 'test-coach-pass');
    const w = (await call('POST', '/api/admin/workouts', { title: 'Core', published: true, exercises: [{ name: 'Plank' }] }, coach)).body.workout;
    await call('PUT', '/api/admin/wod/2026-11-20', { workout_id: w.id }, coach);
    assert.equal((await call('GET', '/api/me', undefined, coach)).body.user.email_verified, 1, 'coach needs no verification');

    outbox.length = 0;
    const reg = await register('Zed', 'zed@example.com');
    assert.equal(reg.verification_required, true);
    const mail = outbox.find((m) => m.to === 'zed@example.com');
    assert.match(mail.text, new RegExp(`^.*${WEB.replace(/[.]/g, '\\.')}/#/verify\\?token=`, 'm'));

    const url = `/api/workouts/${w.id}/feedback`;
    assert.equal((await call('POST', url, { body: 'hi' }, reg.token)).body.error, 'verify_email');
    assert.equal((await call('GET', '/api/wod/download', undefined, reg.token)).body.error, 'verify_email');
    assert.equal((await call('GET', url)).status, 200, 'viewing still works');

    assert.equal((await call('POST', '/api/auth/verify', { token: 'A'.repeat(43) })).status, 400);
    assert.equal((await call('POST', '/api/auth/verify', { token: tokenIn(mail) })).status, 200);
    assert.equal((await call('POST', '/api/auth/verify', { token: tokenIn(mail) })).status, 400, 'a link works once');
    assert.equal((await call('POST', url, { body: 'hi' }, reg.token)).status, 201);
    assert.equal((await call('GET', '/api/wod/download', undefined, reg.token)).status, 200);

    // resend: new link replaces the old one, and is limited
    const reg2 = await register('Yan', 'yan@example.com');
    outbox.length = 0;
    assert.equal((await call('POST', '/api/auth/resend-verification', {}, reg2.token)).status, 200);
    assert.equal((await call('POST', '/api/auth/verify', { token: tokenIn(outbox[0]) })).status, 200);
  });
});

test('forgot and reset password', async () => {
  await withApp({}, async () => {
    const reg = await register('Dee', 'dee@example.com', 'old-password-1');
    outbox.length = 0;

    // no hint whether an address has an account, and the coach cannot be reset by email
    for (const e of ['nobody@example.com', 'TestCoach', 'not an email']) {
      const r = await call('POST', '/api/auth/forgot', { email: e });
      assert.equal(r.status, 200);
      assert.equal(r.body.ok, true);
    }
    assert.equal(outbox.length, 0);

    assert.equal((await call('POST', '/api/auth/forgot', { email: 'DEE@example.com' })).status, 200);
    assert.equal(outbox.length, 1);
    const mail = outbox[0];
    assert.equal(mail.to, 'dee@example.com');
    assert.match(mail.text, /#\/reset\?token=/);
    const token = tokenIn(mail);

    assert.equal((await call('POST', '/api/auth/reset', { token, password: 'short' })).status, 400);
    assert.equal((await call('POST', '/api/auth/reset', { token: 'B'.repeat(43), password: 'new-password-1' })).status, 400);
    assert.equal((await call('POST', '/api/auth/reset', { token, password: 'new-password-1' })).status, 200);
    assert.equal((await call('POST', '/api/auth/reset', { token, password: 'another-pass-1' })).status, 400, 'a reset link works once');

    // the old session and the old password are dead; the new password works
    assert.equal((await call('GET', '/api/me', undefined, reg.token)).status, 401);
    assert.equal((await call('POST', '/api/auth/login', { email: 'dee@example.com', password: 'old-password-1' })).status, 401);
    assert.equal((await call('POST', '/api/auth/login', { email: 'dee@example.com', password: 'new-password-1' })).status, 200);

    // a verify link cannot be used as a reset link
    const reg2 = await register('Eli', 'eli@example.com');
    const verifyMail = outbox.find((m) => m.to === 'eli@example.com');
    assert.equal((await call('POST', '/api/auth/reset', { token: tokenIn(verifyMail), password: 'new-password-1' })).status, 400);
    void reg2;
  });
});
