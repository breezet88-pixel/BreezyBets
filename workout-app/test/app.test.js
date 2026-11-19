import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/server.js';

// 1x1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

let app, base, uploadDir, cookie = '';

async function call(method, url, body, extra = {}) {
  const headers = { ...extra };
  if (cookie) headers.cookie = cookie;
  let payload = body;
  if (body !== undefined && !Buffer.isBuffer(body)) { payload = JSON.stringify(body); headers['content-type'] = 'application/json'; }
  const res = await fetch(base + url, { method, headers, body: payload });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, body: ct.includes('json') ? await res.json() : await res.text() };
}

before(async () => {
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-test-'));
  app = createApp({ dbPath: ':memory:', uploadDir, adminPassword: 'correct horse', secret: 'test-secret', loginLimit: 3 });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
});

after(async () => {
  await app.close();
  fs.rmSync(uploadDir, { recursive: true, force: true });
});

test('public library starts empty and is read only', async () => {
  const r = await call('GET', '/api/workouts');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.workouts, []);
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const w = await call(method, '/api/workouts', { title: 'x' });
    assert.ok([404, 405].includes(w.status), `${method} should not be allowed`);
  }
});

test('admin routes require sign in', async () => {
  assert.equal((await call('GET', '/api/admin/workouts')).status, 401);
  assert.equal((await call('POST', '/api/admin/workouts', { title: 'x' })).status, 401);
  assert.equal((await call('POST', '/api/admin/upload', PNG)).status, 401);
  assert.equal((await call('GET', '/api/admin/me')).body.admin, false);
});

test('wrong password is rejected, then rate limited', async () => {
  for (let i = 0; i < 3; i++) assert.equal((await call('POST', '/api/admin/login', { password: 'nope' })).status, 401);
  // limit is 3: even the right password is refused until the window passes
  assert.equal((await call('POST', '/api/admin/login', { password: 'correct horse' })).status, 429);
});

test('forged session cookie is rejected', async () => {
  cookie = `fl_admin=${Date.now() + 100000}.deadbeef`;
  assert.equal((await call('GET', '/api/admin/workouts')).status, 401);
  cookie = '';
});

// A fresh app for the sign-in flow so the rate limit above doesn't interfere.
test('full admin flow: sign in, upload, create, publish, view, delete', async () => {
  const app2 = createApp({ dbPath: ':memory:', uploadDir, adminPassword: 'correct horse', secret: 'test-secret' });
  await new Promise((r) => app2.server.listen(0, r));
  const saved = base;
  base = `http://localhost:${app2.server.address().port}`;
  cookie = '';
  try {
    const login = await call('POST', '/api/admin/login', { password: 'correct horse' });
    assert.equal(login.status, 200);
    assert.match(login.headers.get('set-cookie'), /HttpOnly/);
    assert.match(login.headers.get('set-cookie'), /SameSite=Strict/);
    assert.equal((await call('GET', '/api/admin/me')).body.admin, true);

    // upload: only real images
    assert.equal((await call('POST', '/api/admin/upload', Buffer.from('<script>alert(1)</script>'))).status, 400);
    const up = await call('POST', '/api/admin/upload', PNG, { 'content-type': 'image/png' });
    assert.equal(up.status, 201);
    assert.match(up.body.file, /^[a-f0-9]{32}\.png$/);

    // validation
    assert.equal((await call('POST', '/api/admin/workouts', { title: '' })).status, 400);
    assert.equal((await call('POST', '/api/admin/workouts', { title: 'A', exercises: [{ name: 'Squat', image: '../../etc/passwd' }] })).status, 400);
    assert.equal((await call('POST', '/api/admin/workouts', { title: 'A', exercises: [{ name: 'Squat', image: 'a'.repeat(32) + '.png' }] })).status, 400);
    assert.equal((await call('POST', '/api/admin/workouts', { title: 'A', duration_min: 'abc' })).status, 400);

    // create as draft
    const created = await call('POST', '/api/admin/workouts', {
      title: 'Full Body Starter', category: 'Strength', level: 'Beginner', duration_min: 30, published: false,
      exercises: [
        { name: 'Goblet Squat', muscles: 'Quads, glutes', equipment: 'Dumbbell', sets: '3', reps: '10-12', rest_sec: 60, cues: 'Chest up', image: up.body.file },
        { name: 'Push-up', sets: '3', reps: 'AMRAP', rest_sec: 45 },
      ],
    });
    assert.equal(created.status, 201);
    const id = created.body.workout.id;
    assert.equal(created.body.workout.exercises.length, 2);

    // drafts are invisible to the public
    const anon = base; cookie = '';
    assert.deepEqual((await call('GET', '/api/workouts')).body.workouts, []);
    assert.equal((await call('GET', `/api/workouts/${id}`)).status, 404);
    await call('POST', '/api/admin/login', { password: 'correct horse' });

    // publish + reorder exercises
    const w = created.body.workout;
    const upd = await call('PUT', `/api/admin/workouts/${id}`, { ...w, published: true, exercises: [...w.exercises].reverse() });
    assert.equal(upd.status, 200);
    assert.equal(upd.body.workout.exercises[0].name, 'Push-up');

    cookie = '';
    const list = await call('GET', '/api/workouts');
    assert.equal(list.body.workouts.length, 1);
    assert.equal(list.body.workouts[0].exercise_count, 2);
    assert.equal(list.body.workouts[0].cover, up.body.file);
    const one = await call('GET', `/api/workouts/${id}`);
    assert.equal(one.body.workout.title, 'Full Body Starter');

    // image is served publicly, with safe headers
    const img = await fetch(`${base}/uploads/${up.body.file}`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await fetch(`${base}/uploads/..%2f..%2fserver%2fserver.js`)).status, 404);

    // delete
    await call('POST', '/api/admin/login', { password: 'correct horse' });
    assert.equal((await call('DELETE', `/api/admin/workouts/${id}`)).status, 200);
    assert.equal((await call('GET', `/api/admin/workouts/${id}`)).status, 404);
    void anon;
  } finally {
    base = saved;
    await app2.close();
  }
});

test('static files: app shell served with CSP, traversal blocked', async () => {
  const idx = await call('GET', '/');
  assert.equal(idx.status, 200);
  assert.match(idx.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal((await call('GET', '/admin')).status, 200);
  assert.equal((await call('GET', '/manifest.webmanifest')).status, 200);
  assert.equal((await call('GET', '/..%2fserver%2fserver.js')).status, 404);
  assert.equal((await call('GET', '/nope.js')).status, 404);
});
