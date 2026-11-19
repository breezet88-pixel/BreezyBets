// Passwords (scrypt), login sessions (random tokens, only their SHA-256 is stored) and rate limiting.
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

// Used so that "no such email" takes as long as "wrong password".
export const DUMMY_HASH = await hashPassword('not-a-real-password');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function createSession(db, userId, ttlMs) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)').run(sha256(token), userId, now + ttlMs);
  return token;
}

export function userForToken(db, token) {
  if (!token) return null;
  return db.prepare(
    `SELECT u.id, u.email, u.name, u.role, u.blocked FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ? AND u.blocked = 0`,
  ).get(sha256(token), Date.now()) || null;
}

export function deleteSession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function bearer(req) {
  const m = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(String(req.headers.authorization || ''));
  return m ? m[1] : null;
}

// Simple in-memory counter per key (IP) within a time window.
export class Limiter {
  constructor() { this.hits = new Map(); }
  count(key) {
    const e = this.hits.get(key);
    if (!e || e.resetAt < Date.now()) { this.hits.delete(key); return 0; }
    return e.n;
  }
  add(key, windowMs) {
    const e = this.hits.get(key);
    if (!e || e.resetAt < Date.now()) this.hits.set(key, { n: 1, resetAt: Date.now() + windowMs });
    else e.n++;
  }
  clear(key) { this.hits.delete(key); }
}
