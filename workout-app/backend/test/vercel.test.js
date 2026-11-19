// The whole app running on the Vercel storage adapters (Turso database + Vercel Blob pictures),
// against protocol-accurate fakes of both services.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/server.js';
import { tursoStore } from '../server/store.js';
import { blobFiles } from '../server/files.js';
import { fakeTurso, fakeBlob } from './fakes.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const BLOB_TOKEN = 'vercel_blob_rw_FakeStore123_secretpart';
const outbox = [];
let turso, blob, app, base;

async function call(method, url, body, token, extra = {}) {
  const headers = { ...extra };
  if (token) headers.authorization = `Bearer ${token}`;
  let payload = body;
  if (body !== undefined && !Buffer.isBuffer(body)) { payload = JSON.stringify(body); headers['content-type'] = 'application/json'; }
  const res = await fetch(base + url, { method, headers, body: payload });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, body: ct.includes('json') ? await res.json() : await res.text() };
}

before(async () => {
  turso = await fakeTurso({ token: 'turso-token' });
  blob = await fakeBlob({ token: BLOB_TOKEN });
  app = createApp({
    store: tursoStore({ url: turso.url, authToken: 'turso-token' }),
    files: blobFiles({ token: BLOB_TOKEN, apiUrl: blob.apiUrl, fetchImpl: blob.fetchImpl }),
    adminUsername: 'TestCoach', adminPassword: 'test-coach-pass',
    mailer: { real: false, async send(m) { outbox.push(m); } },
    trustProxy: true, accountLoginLimit: 3, pruneGraceMs: 0, maxEmbedBytes: 1024 * 1024,
  });
  await app.ready;
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
});

after(async () => { await app.close(); await turso.close(); await blob.close(); });

test('Turso: schema created and the coach account set up through the HTTP protocol', async () => {
  const tables = turso.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
  for (const t of ['users', 'sessions', 'workouts', 'exercises', 'wod_schedule', 'feedback', 'email_tokens', 'settings', 'limits']) assert.ok(tables.includes(t), t);
  assert.equal(turso.db.prepare("SELECT role FROM users WHERE email = 'testcoach'").get().role, 'admin');
});

test('Turso: a batch that fails part-way changes nothing (all or nothing)', async () => {
  const store = tursoStore({ url: turso.url, authToken: 'turso-token' });
  await assert.rejects(store.batch([
    ["INSERT INTO settings (key, value) VALUES ('batch-test', 'x')", []],
    ['INSERT INTO no_such_table VALUES (1)', []],
  ]), /Database error/);
  assert.equal(turso.db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'batch-test'").get().n, 0);
  const bad = tursoStore({ url: turso.url, authToken: 'wrong' });
  await assert.rejects(bad.all('SELECT 1'), /HTTP 401/);
});

test('full flow on Turso + Blob: upload, publish, WOD download, reviews, picture clean-up', async () => {
  const coach = (await call('POST', '/api/auth/login', { login: 'TestCoach', password: 'test-coach-pass' })).body.token;
  assert.ok(coach);

  // upload goes to Blob and comes back as a public https address in your store
  const up = await call('POST', '/api/admin/upload', PNG, coach);
  assert.equal(up.status, 201);
  assert.match(up.body.file, /^https:\/\/fakestore123\.public\.blob\.vercel-storage\.com\/uploads\/[a-f0-9]{32}\.png$/);
  assert.equal(blob.blobs.size, 1);

  // only addresses from YOUR store are accepted as exercise pictures
  for (const image of ['https://evil.example.com/uploads/' + 'a'.repeat(32) + '.png',
    'https://otherstore.public.blob.vercel-storage.com/uploads/' + 'a'.repeat(32) + '.png', 'javascript:alert(1)']) {
    assert.equal((await call('POST', '/api/admin/workouts', { title: 'X', exercises: [{ name: 'A', image }] }, coach)).status, 400, image);
  }

  const w = (await call('POST', '/api/admin/workouts', {
    title: 'Blob Day', published: true, exercises: [{ name: 'Squat', image: up.body.file, sets: '3', reps: '10' }, { name: 'Plank' }],
  }, coach)).body.workout;
  assert.equal(w.exercises.length, 2);
  const day = (await call('GET', '/api/wod')).body.day;
  await call('PUT', `/api/admin/wod/${day}`, { workout_id: w.id }, coach);

  // customer: register, review, download with the picture embedded (read back from Blob)
  const cust = (await call('POST', '/api/auth/register', { name: 'Lu', email: 'lu@example.com', password: 'longenough1' })).body.token;
  assert.equal((await call('POST', `/api/workouts/${w.id}/feedback`, { rating: 5, body: 'Great' }, cust)).status, 201);
  assert.equal((await call('POST', `/api/workouts/${w.id}/feedback`, { rating: 4 }, cust)).status, 409);
  const dl = await call('GET', '/api/wod/download', undefined, cust);
  assert.equal(dl.status, 200);
  assert.match(dl.body, /data:image\/png;base64,/);

  // removing the picture deletes it from Blob; deleting the workout cleans up schedule and reviews
  await call('PUT', `/api/admin/workouts/${w.id}`, { ...w, exercises: w.exercises.map((e) => ({ ...e, image: '' })) }, coach);
  assert.equal(blob.blobs.size, 0, 'unused picture removed from Blob');
  assert.equal((await call('DELETE', `/api/admin/workouts/${w.id}`, undefined, coach)).status, 200);
  assert.equal(turso.db.prepare('SELECT COUNT(*) AS n FROM feedback').get().n, 0);
  assert.equal(turso.db.prepare('SELECT COUNT(*) AS n FROM wod_schedule').get().n, 0);
});

test('download stays under the size cap: large pictures are linked instead of embedded', async () => {
  const coach = (await call('POST', '/api/auth/login', { login: 'TestCoach', password: 'test-coach-pass' })).body.token;
  const big = Buffer.concat([PNG, Buffer.alloc(700 * 1024)]); // passes the PNG check, ~700 KB
  const a = (await call('POST', '/api/admin/upload', big, coach)).body.file;
  const b = (await call('POST', '/api/admin/upload', big, coach)).body.file;
  const w = (await call('POST', '/api/admin/workouts', { title: 'Big', published: true, exercises: [{ name: 'One', image: a }, { name: 'Two', image: b }] }, coach)).body.workout;
  const day = (await call('GET', '/api/wod')).body.day;
  await call('PUT', `/api/admin/wod/${day}`, { workout_id: w.id }, coach);
  const cust = (await call('POST', '/api/auth/login', { email: 'lu@example.com', password: 'longenough1' })).body.token;
  const html = (await call('GET', '/api/wod/download', undefined, cust)).body;
  assert.equal((html.match(/data:image\/png;base64,/g) || []).length, 1, 'first picture embedded (1 MB cap)');
  assert.ok(html.includes(`src="${b}"`), 'second picture linked by its address');
  await call('DELETE', `/api/admin/workouts/${w.id}`, undefined, coach);
});

test('lockout works across server copies: counts live in the database, not in memory', async () => {
  // a second, separate server instance sharing the same database (as Vercel runs several copies)
  const twin = createApp({ store: tursoStore({ url: turso.url, authToken: 'turso-token' }), files: blobFiles({ token: BLOB_TOKEN, apiUrl: blob.apiUrl, fetchImpl: blob.fetchImpl }), trustProxy: true, accountLoginLimit: 3 });
  await twin.ready;
  await new Promise((r) => twin.server.listen(0, r));
  const twinBase = `http://localhost:${twin.server.address().port}`;
  const tryLogin = (b, pw, ip) => fetch(`${b}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify({ login: 'TestCoach', password: pw }) }).then((r) => r.status);
  try {
    assert.equal(await tryLogin(base, 'guess-1', '10.0.0.1'), 401);
    assert.equal(await tryLogin(twinBase, 'guess-2', '10.0.0.2'), 401);
    assert.equal(await tryLogin(base, 'guess-3', '10.0.0.3'), 401);
    assert.equal(await tryLogin(twinBase, 'test-coach-pass', '10.0.0.4'), 429, 'locked on the other copy too');
  } finally {
    await new Promise((r) => twin.server.close(r));
    turso.db.prepare("DELETE FROM limits WHERE key LIKE 'login-%'").run();
  }
});

test('forgot/reset on Turso: links work once (DELETE ... RETURNING)', async () => {
  outbox.length = 0;
  await call('POST', '/api/auth/forgot', { email: 'lu@example.com' });
  await new Promise((r) => setTimeout(r, 50));
  const token = /token=([A-Za-z0-9_-]+)/.exec(outbox.find((m) => m.subject.includes('Reset')).text)[1];
  assert.equal((await call('POST', '/api/auth/reset', { token, password: 'brand-new-pass' })).status, 200);
  assert.equal((await call('POST', '/api/auth/reset', { token, password: 'again-new-pass' })).status, 400);
  assert.equal((await call('POST', '/api/auth/login', { email: 'lu@example.com', password: 'brand-new-pass' })).status, 200);
});
