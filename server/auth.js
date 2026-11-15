import { scrypt, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const scryptAsync = promisify(scrypt);

export const SESSION_TTL_MS = 7 * 864e5;

export async function hashPassword(pw) {
  const salt = randomBytes(16);
  const h = await scryptAsync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}
export async function verifyPassword(pw, stored) {
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hashHex, 'hex');
  const h = await scryptAsync(pw, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(h, expected);
}
const sha = t => createHash('sha256').update(t).digest('hex');

export function createSession(db, userId) {
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)').run(sha(token), userId, Date.now() + SESSION_TTL_MS);
  return token; // only the hash is stored server-side
}
export function userForToken(db, token) {
  if (!token) return null;
  return db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?').get(sha(token), Date.now()) || null;
}
export const destroySession = (db, token) => db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(token));

// Valid 'YYYY-MM-DD' real calendar date -> age in whole years (or null if invalid).
export function ageFromDob(dob, now = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob || ''); if (!m) return null;
  const [y, mo, d] = [+m[1], +m[2], +m[3]], dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d || dt > now) return null;
  let age = now.getUTCFullYear() - y;
  if (now.getUTCMonth() < mo - 1 || (now.getUTCMonth() === mo - 1 && now.getUTCDate() < d)) age--;
  return age;
}

// Tiny in-memory failure limiter (per key). Use Redis or similar when running >1 instance.
export function createLimiter(max, windowMs) {
  const hits = new Map();
  const recent = k => { const t = Date.now(); const a = (hits.get(k) || []).filter(x => t - x < windowMs); hits.set(k, a); return a; };
  return { blocked: k => recent(k).length >= max, fail: k => recent(k).push(Date.now()), reset: k => hits.delete(k) };
}
