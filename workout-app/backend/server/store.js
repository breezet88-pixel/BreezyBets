// Database access, the same for every host. Two implementations of one small async interface:
//   all(sql, params) -> rows      get(sql, params) -> row | undefined
//   run(sql, params) -> { changes, lastInsertRowid }
//   batch([[sql, params], ...])  -> runs all statements as ONE transaction (all or nothing)
//   script(sqlText)              -> runs a multi-statement script (used for the schema)
//
// - Local / Fly / Docker: a SQLite file via Node's built-in node:sqlite.
// - Vercel: Turso (hosted SQLite, from the Vercel Marketplace) over its HTTP API, no npm packages.
//   Turso sets TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.
import fs from 'node:fs';
import path from 'node:path';

export async function openStore({ dbPath, tursoUrl = process.env.TURSO_DATABASE_URL, tursoToken = process.env.TURSO_AUTH_TOKEN, fetchImpl } = {}) {
  if (tursoUrl) return tursoStore({ url: tursoUrl, authToken: tursoToken, fetchImpl });
  return sqliteStore(dbPath);
}

// ---------------------------------------------------------------- SQLite file
export async function sqliteStore(dbPath) {
  const { DatabaseSync } = await import('node:sqlite'); // loaded only when used, so Vercel never needs it
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  if (dbPath !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  const clean = (params) => params.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
  const runOne = (sql, params = []) => {
    const r = db.prepare(sql).run(...clean(params));
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  };
  return {
    kind: 'sqlite',
    async all(sql, params = []) { return db.prepare(sql).all(...clean(params)).map((r) => ({ ...r })); },
    async get(sql, params = []) { const r = db.prepare(sql).get(...clean(params)); return r ? { ...r } : undefined; },
    async run(sql, params = []) { return runOne(sql, params); },
    async batch(stmts) {
      db.exec('BEGIN');
      try {
        const out = stmts.map(([sql, params]) => runOne(sql, params));
        db.exec('COMMIT');
        return out;
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    async script(sqlText) { db.exec(sqlText); },
    close() { db.close(); },
  };
}

// ---------------------------------------------------------------- Turso over HTTP
// Protocol: POST <db>/v2/pipeline with { requests: [...] }. Values are typed: integers travel as strings.
export function tursoStore({ url, authToken, fetchImpl = fetch }) {
  if (!authToken) throw new Error('TURSO_AUTH_TOKEN is not set.');
  const base = String(url).replace(/^libsql:\/\//, 'https://').replace(/\/+$/, '');

  const arg = (v) => {
    if (v === null || v === undefined) return { type: 'null' };
    if (typeof v === 'boolean') return { type: 'integer', value: v ? '1' : '0' };
    if (typeof v === 'bigint') return { type: 'integer', value: v.toString() };
    if (typeof v === 'number') return Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v };
    return { type: 'text', value: String(v) };
  };
  const value = (c) => {
    switch (c?.type) {
      case 'integer': return Number(c.value);
      case 'float': return Number(c.value);
      case 'text': return c.value;
      case 'blob': return Buffer.from(c.base64 || '', 'base64');
      default: return null;
    }
  };
  const rowsOf = (res) => res.rows.map((r) => Object.fromEntries(res.cols.map((c, i) => [c.name, value(r[i])])));
  const runResult = (r) => ({ changes: r.affected_row_count, lastInsertRowid: r.last_insert_rowid == null ? 0 : Number(r.last_insert_rowid) });
  const stmt = (sql, params = []) => ({ sql, args: params.map(arg), want_rows: true });
  const fail = (e) => new Error(`Database error: ${e?.message || 'unknown'}`);

  async function pipeline(requests) {
    const res = await fetchImpl(`${base}/v2/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [...requests, { type: 'close' }] }),
    });
    if (!res.ok) throw new Error(`Database request failed (HTTP ${res.status}). Check TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.`);
    return (await res.json()).results;
  }
  async function execute(sql, params) {
    const [r] = await pipeline([{ type: 'execute', stmt: stmt(sql, params) }]);
    if (r.type !== 'ok') throw fail(r.error);
    return r.response.result;
  }

  return {
    kind: 'turso',
    async all(sql, params) { return rowsOf(await execute(sql, params)); },
    async get(sql, params) { return rowsOf(await execute(sql, params))[0]; },
    async run(sql, params) { return runResult(await execute(sql, params)); },
    async batch(stmts) {
      // BEGIN; each statement only if the previous one worked; COMMIT; ROLLBACK if COMMIT did not happen.
      const steps = [{ stmt: stmt('BEGIN') }];
      for (const [sql, params] of stmts) steps.push({ condition: { type: 'ok', step: steps.length - 1 }, stmt: stmt(sql, params) });
      const commit = steps.length;
      steps.push({ condition: { type: 'ok', step: commit - 1 }, stmt: stmt('COMMIT') });
      steps.push({ condition: { type: 'not', cond: { type: 'ok', step: commit } }, stmt: stmt('ROLLBACK') });
      const [r] = await pipeline([{ type: 'batch', batch: { steps } }]);
      if (r.type !== 'ok') throw fail(r.error);
      const { step_results: results, step_errors: errors } = r.response.result;
      const err = errors.find(Boolean);
      if (err) throw fail(err);
      return results.slice(1, 1 + stmts.length).map(runResult);
    },
    async script(sqlText) {
      const parts = sqlText.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
        .split(';').map((s) => s.trim()).filter(Boolean);
      const results = await pipeline(parts.map((s) => ({ type: 'execute', stmt: stmt(s) })));
      const bad = results.find((r) => r.type !== 'ok');
      if (bad) throw fail(bad.error);
    },
    close() {},
  };
}
