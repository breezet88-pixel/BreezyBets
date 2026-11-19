// Database schema. Works on the local SQLite file and on Turso (hosted SQLite) alike.
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','customer')),
  password_hash TEXT NOT NULL,
  blocked INTEGER NOT NULL DEFAULT 0,
  email_verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
-- One-time links sent by email: verify an address, or reset a password.
CREATE TABLE IF NOT EXISTS email_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('verify','reset')),
  expires_at INTEGER NOT NULL
);
-- Coach-editable site settings (the donation link and message live here).
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  level TEXT NOT NULL DEFAULT '',
  duration_min INTEGER,
  published INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS exercises (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workout_id INTEGER NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  muscles TEXT NOT NULL DEFAULT '',
  equipment TEXT NOT NULL DEFAULT '',
  sets TEXT NOT NULL DEFAULT '',
  reps TEXT NOT NULL DEFAULT '',
  rest_sec INTEGER,
  cues TEXT NOT NULL DEFAULT '',
  image TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS exercises_workout ON exercises(workout_id, position);
-- Which workout is "the workout of the day" for each calendar day.
CREATE TABLE IF NOT EXISTS wod_schedule (
  day TEXT PRIMARY KEY,
  workout_id INTEGER NOT NULL REFERENCES workouts(id) ON DELETE CASCADE
);
-- Customer comments (rating NULL) and reviews (rating 1-5).
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workout_id INTEGER NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating INTEGER CHECK (rating BETWEEN 1 AND 5),
  body TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  CHECK (rating IS NOT NULL OR body <> '')
);
-- Counters for rate limits and login lockouts. Kept in the database (not memory) so they hold
-- even when the host runs several copies of the server at once, as Vercel does.
CREATE TABLE IF NOT EXISTS limits (
  key TEXT PRIMARY KEY,
  n INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS feedback_workout ON feedback(workout_id, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS feedback_one_rating ON feedback(workout_id, user_id) WHERE rating IS NOT NULL;
`;

export async function migrate(store) {
  await store.script(SCHEMA);
  // databases created before email verification existed
  const cols = await store.all('PRAGMA table_info(users)');
  if (!cols.some((c) => c.name === 'email_verified')) {
    await store.run('ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0');
  }
}
