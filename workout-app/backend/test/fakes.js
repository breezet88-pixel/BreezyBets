// Test doubles for the two hosted services used on Vercel, speaking the same HTTP protocols:
//  - fakeTurso: Turso's /v2/pipeline (execute, batch with conditions, close), backed by a real SQLite db.
//  - fakeBlob:  Vercel Blob's API (PUT /?pathname=, GET ?prefix=, POST /delete) plus public file URLs.
// They check the auth headers the real services require, so a request-format mistake fails a test.
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';

const listen = (server) => new Promise((r) => server.listen(0, () => r(server.address().port)));
const readAll = (req) => new Promise((resolve) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => resolve(Buffer.concat(c))); });

export async function fakeTurso({ token }) {
  const db = new DatabaseSync(':memory:');
  const calls = [];
  const enc = (v) => (v === null || v === undefined ? { type: 'null' }
    : typeof v === 'number' ? (Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v })
      : typeof v === 'bigint' ? { type: 'integer', value: v.toString() } : { type: 'text', value: String(v) });
  const dec = (a) => (a.type === 'null' ? null : a.type === 'integer' ? Number(a.value) : a.type === 'float' ? a.value : a.value);
  function execute(stmt) {
    const st = db.prepare(stmt.sql);
    const args = (stmt.args || []).map(dec);
    const cols = st.columns();
    if (cols.length) {
      const rows = st.all(...args);
      return { cols: cols.map((c) => ({ name: c.name })), rows: rows.map((r) => Object.values(r).map(enc)), affected_row_count: 0, last_insert_rowid: null };
    }
    const r = st.run(...args);
    return { cols: [], rows: [], affected_row_count: Number(r.changes), last_insert_rowid: String(r.lastInsertRowid) };
  }
  const evalCond = (c, ok) => (c.type === 'ok' ? ok[c.step] === true : c.type === 'error' ? ok[c.step] === false
    : c.type === 'not' ? !evalCond(c.cond, ok) : c.type === 'and' ? c.conds.every((x) => evalCond(x, ok)) : c.conds.some((x) => evalCond(x, ok)));
  const server = http.createServer(async (req, res) => {
    const body = JSON.parse((await readAll(req)).toString() || '{}');
    calls.push(body);
    if (req.method !== 'POST' || req.url !== '/v2/pipeline') { res.writeHead(404); return res.end(); }
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); return res.end(); }
    const results = body.requests.map((r) => {
      try {
        if (r.type === 'close') return { type: 'ok', response: { type: 'close' } };
        if (r.type === 'execute') return { type: 'ok', response: { type: 'execute', result: execute(r.stmt) } };
        if (r.type === 'batch') {
          const ok = []; const step_results = []; const step_errors = [];
          r.batch.steps.forEach((s, i) => {
            if (s.condition && !evalCond(s.condition, ok)) { ok[i] = undefined; step_results.push(null); step_errors.push(null); return; }
            try { step_results.push(execute(s.stmt)); step_errors.push(null); ok[i] = true; }
            catch (e) { step_results.push(null); step_errors.push({ message: e.message }); ok[i] = false; }
          });
          return { type: 'ok', response: { type: 'batch', result: { step_results, step_errors } } };
        }
        return { type: 'error', error: { message: `unknown request ${r.type}` } };
      } catch (e) { return { type: 'error', error: { message: e.message } }; }
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ baton: null, base_url: null, results }));
  });
  const port = await listen(server);
  return { url: `http://localhost:${port}`, db, calls, close: () => new Promise((r) => server.close(r)) };
}

export async function fakeBlob({ token }) {
  const storeId = token.split('_')[3];
  const host = `${storeId.toLowerCase()}.public.blob.vercel-storage.com`;
  const blobs = new Map(); // pathname -> { bytes, type, uploadedAt }
  const authOk = (req) => req.headers.authorization === `Bearer ${token}` && req.headers['x-api-version'] === '13' && req.headers['x-vercel-blob-store-id'] === storeId;
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
    if (u.pathname.startsWith('/public/')) { // the public picture addresses
      const b = blobs.get(u.pathname.slice('/public/'.length));
      if (!b) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': b.type }); return res.end(b.bytes);
    }
    if (!authOk(req)) return send(403, { error: { code: 'forbidden' } });
    if (req.method === 'PUT' && u.pathname === '/api/blob/') {
      const pathname = u.searchParams.get('pathname');
      if (req.headers['x-vercel-blob-access'] !== 'public' || !pathname) return send(400, { error: { code: 'bad_request' } });
      blobs.set(pathname, { bytes: await readAll(req), type: req.headers['x-content-type'], uploadedAt: new Date().toISOString() });
      return send(200, { url: `https://${host}/${pathname}`, pathname, contentType: req.headers['x-content-type'] });
    }
    if (req.method === 'GET' && u.pathname === '/api/blob') {
      const prefix = u.searchParams.get('prefix') || '';
      const list = [...blobs.entries()].filter(([p]) => p.startsWith(prefix))
        .map(([p, b]) => ({ url: `https://${host}/${p}`, pathname: p, size: b.bytes.length, uploadedAt: b.uploadedAt }));
      return send(200, { blobs: list, hasMore: false });
    }
    if (req.method === 'POST' && u.pathname === '/api/blob/delete') {
      const { urls } = JSON.parse((await readAll(req)).toString());
      for (const x of urls) blobs.delete(new URL(x).pathname.slice(1));
      return send(200, {});
    }
    return send(404, { error: { code: 'not_found' } });
  });
  const port = await listen(server);
  const local = `http://localhost:${port}`;
  // Route the public https addresses to the fake server (stands in for Blob's CDN).
  const fetchImpl = (input, init) => {
    const s = String(input);
    return fetch(s.startsWith(`https://${host}/`) ? `${local}/public/${s.slice(`https://${host}/`.length)}` : s, init);
  };
  return { apiUrl: `${local}/api/blob`, host, blobs, fetchImpl, close: () => new Promise((r) => server.close(r)) };
}
