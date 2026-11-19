import fs from 'node:fs';
import path from 'node:path';

export class HttpError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}

export const IMAGE_NAME = /^[a-f0-9]{32}\.(png|jpg|webp|gif)$/;

export function text(v, max, label, required = false) {
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string' && typeof v !== 'number') throw new HttpError(400, 'invalid', `${label} must be text.`);
  const s = String(v).trim();
  if (required && !s) throw new HttpError(400, 'invalid', `${label} is required.`);
  if (s.length > max) throw new HttpError(400, 'invalid', `${label} is too long (max ${max} characters).`);
  return s;
}

export function intOrNull(v, min, max, label) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, 'invalid', `${label} must be a whole number from ${min} to ${max}.`);
  return n;
}

export function normEmail(v) {
  return String(v ?? '').trim().toLowerCase();
}

export function validEmail(e) {
  return e.length <= 254 && /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(e);
}

export function validDay(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function cleanWorkout(body, uploadRoot) {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'invalid', 'Missing workout.');
  const list = body.exercises ?? [];
  if (!Array.isArray(list) || list.length > 100) throw new HttpError(400, 'invalid', 'A workout can have up to 100 exercises.');
  return {
    title: text(body.title, 120, 'Title', true),
    description: text(body.description, 2000, 'Description'),
    category: text(body.category, 40, 'Category'),
    level: text(body.level, 40, 'Level'),
    duration_min: intOrNull(body.duration_min, 1, 600, 'Duration'),
    published: body.published ? 1 : 0,
    exercises: list.map((e, i) => {
      const n = `Exercise ${i + 1}`;
      if (!e || typeof e !== 'object') throw new HttpError(400, 'invalid', `${n} is not valid.`);
      const image = text(e.image, 80, `${n} image`);
      if (image && (!IMAGE_NAME.test(image) || !fs.existsSync(path.join(uploadRoot, image)))) {
        throw new HttpError(400, 'invalid', `${n} image was not found. Upload it again.`);
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
}

// ---- donations: the app never handles money; it only links to your payment page ----
function httpsUrl(v, label, placeholder) {
  const raw = text(v, 500, label);
  if (!raw) return '';
  let u;
  try { u = new URL(placeholder ? raw.split('{amount}').join('50') : raw); } catch { throw new HttpError(400, 'invalid', `${label} is not a valid web address.`); }
  if (u.protocol !== 'https:') throw new HttpError(400, 'invalid', `${label} must start with https://`);
  if (u.username || u.password) throw new HttpError(400, 'invalid', `${label} must not contain a username or password.`);
  return raw;
}

export const DEFAULT_AMOUNTS = [20, 50, 100, 200];

export function cleanDonate(body) {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'invalid', 'Missing settings.');
  const url = httpsUrl(body.url, 'Donation link');
  const amount_url = httpsUrl(body.amount_url, 'Amount link', true);
  if (amount_url && !amount_url.includes('{amount}')) throw new HttpError(400, 'invalid', 'The amount link must contain {amount} where the rand amount goes.');
  const message = text(body.message, 400, 'Message');
  let amounts = DEFAULT_AMOUNTS;
  if (body.amounts !== undefined) {
    if (!Array.isArray(body.amounts) || body.amounts.length > 6) throw new HttpError(400, 'invalid', 'Give up to 6 suggested amounts.');
    amounts = [...new Set(body.amounts.map((n) => {
      const v = Number(n);
      if (!Number.isInteger(v) || v < 1 || v > 100000) throw new HttpError(400, 'invalid', 'Suggested amounts must be whole rand from 1 to 100000.');
      return v;
    }))].sort((a, b) => a - b);
  }
  return { url, amount_url, message, amounts };
}
