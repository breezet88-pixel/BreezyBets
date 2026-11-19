// Passwords (scrypt), login sessions (random tokens; only their SHA-256 is stored),
// one-time email links, and rate-limit counters. All data lives in the database store.
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `${salt.toString('hex')}:${key.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [salt, key] = String(stored).split(':');
  if (!salt || !key) return false;
  const got = await scrypt(password, Buffer.from(salt, 'hex'), 64);
  const want = Buffer.from(key, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// Used so that "no such account" takes as long as "wrong password".
export const DUMMY_HASH = await hashPassword('not-a-real-password');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');

export async function createSession(store, userId, ttlMs) {
  const token = newToken();
  const now = Date.now();
  await store.batch([
    ['DELETE FROM sessions WHERE expires_at < ?', [now]],
    ['INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)', [sha256(token), userId, now + ttlMs]],
  ]);
  return token;
}

export async function userForToken(store, token) {
  if (!token) return null;
  return (await store.get(
    `SELECT u.id, u.email, u.name, u.role, u.blocked, u.email_verified FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ? AND u.blocked = 0`,
    [sha256(token), Date.now()],
  )) || null;
}

export async function deleteSession(store, token) {
  if (token) await store.run('DELETE FROM sessions WHERE token_hash = ?', [sha256(token)]);
}

export function bearer(req) {
  const m = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(String(req.headers.authorization || ''));
  return m ? m[1] : null;
}

// ---- one-time email links (verify / reset). Only the hash is stored; the newest link replaces older ones. ----
export async function createEmailToken(store, userId, kind, ttlMs) {
  const token = newToken();
  const now = Date.now();
  await store.batch([
    ['DELETE FROM email_tokens WHERE expires_at < ?', [now]],
    ['DELETE FROM email_tokens WHERE user_id = ? AND kind = ?', [userId, kind]],
    ['INSERT INTO email_tokens (token_hash, user_id, kind, expires_at) VALUES (?,?,?,?)', [sha256(token), userId, kind, now + ttlMs]],
  ]);
  return token;
}

// Uses the link up in one step (so it cannot be used twice, even by two requests at once).
// Returns the user id, or null if the link is unknown, expired or already used.
export async function consumeEmailToken(store, token, kind) {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(String(token || ''))) return null;
  const row = await store.get('DELETE FROM email_tokens WHERE token_hash = ? AND kind = ? AND expires_at > ? RETURNING user_id', [sha256(token), kind, Date.now()]);
  return row ? row.user_id : null;
}

// ---- rate limits: a counter per key (an IP address, an account, ...) inside a time window ----
export function limits(store) {
  return {
    async count(key) {
      const r = await store.get('SELECT n FROM limits WHERE key = ? AND reset_at > ?', [key, Date.now()]);
      return r ? r.n : 0;
    },
    async add(key, windowMs) {
      const now = Date.now();
      await store.batch([
        ['DELETE FROM limits WHERE reset_at < ?', [now - 24 * 60 * 60 * 1000]],
        [`INSERT INTO limits (key, n, reset_at) VALUES (?, 1, ?)
          ON CONFLICT(key) DO UPDATE SET
            n = CASE WHEN limits.reset_at <= ? THEN 1 ELSE limits.n + 1 END,
            reset_at = CASE WHEN limits.reset_at <= ? THEN excluded.reset_at ELSE limits.reset_at END`, [key, now + windowMs, now, now]],
      ]);
    },
    async clear(key) { await store.run('DELETE FROM limits WHERE key = ?', [key]); },
  };
}
