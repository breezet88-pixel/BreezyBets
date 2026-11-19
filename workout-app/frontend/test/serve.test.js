import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontend } from '../serve.js';

test('serves the app, points it at the API, and allows only that API in the CSP', async () => {
  const server = createFrontend({ apiUrl: 'https://api.example.com/some/path' });
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  try {
    const cfg = await fetch(`${base}/config.js`);
    assert.equal(await cfg.text(), 'globalThis.FL_API_URL = "https://api.example.com";\n');
    assert.match(cfg.headers.get('content-security-policy'), /connect-src 'self' https:\/\/api\.example\.com;/);
    assert.equal((await fetch(`${base}/`)).status, 200);
    assert.equal((await fetch(`${base}/admin`)).status, 200);
    assert.equal((await fetch(`${base}/_headers`)).status, 404);
    assert.equal((await fetch(`${base}/..%2fserve.js`)).status, 404);
    assert.equal((await fetch(`${base}/api/workouts`)).status, 404, 'front end has no API of its own');
    assert.equal((await fetch(base, { method: 'POST' })).status, 405);
  } finally { server.close(); }
});
