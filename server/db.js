import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  dob TEXT NOT NULL,
  deposit_limit_cents INTEGER NOT NULL DEFAULT 0,   -- daily; 0 = no limit
  deposit_limit_pending_cents INTEGER,              -- a requested looser limit, waiting out its cooling-off period
  deposit_limit_pending_at INTEGER,                 -- when the pending limit takes effect
  break_until INTEGER,                              -- betting and deposits are paused until then
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);

-- Double-entry ledger. Every transaction's entries sum to zero.
-- Accounts: 'user:<id>' (player wallet, may never go below 0) and 'house:*' accounts.
CREATE TABLE IF NOT EXISTS ledger_txns (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,            -- bonus | deposit | bet_stake | bet_payout | game_stake | game_win
                                 -- | withdrawal | withdrawal_paid | withdrawal_returned
  user_id INTEGER REFERENCES users(id),
  ref TEXT,                      -- e.g. 'bet:42'
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger_entries (
  id INTEGER PRIMARY KEY,
  txn_id INTEGER NOT NULL REFERENCES ledger_txns(id),
  account TEXT NOT NULL,
  amount_cents INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entries_account ON ledger_entries(account);
CREATE INDEX IF NOT EXISTS idx_txns_user ON ledger_txns(user_id, kind, created_at);
-- Append-only: history can never be edited or deleted.
CREATE TRIGGER IF NOT EXISTS ledger_entries_no_update BEFORE UPDATE ON ledger_entries BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
CREATE TRIGGER IF NOT EXISTS ledger_entries_no_delete BEFORE DELETE ON ledger_entries BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
CREATE TRIGGER IF NOT EXISTS ledger_txns_no_update BEFORE UPDATE ON ledger_txns BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
CREATE TRIGGER IF NOT EXISTS ledger_txns_no_delete BEFORE DELETE ON ledger_txns BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;

CREATE TABLE IF NOT EXISTS bets (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,            -- single | multi
  stake_cents INTEGER NOT NULL,
  odds REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',   -- open | won | lost
  payout_cents INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  settled_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_bets_user ON bets(user_id, id);
CREATE TABLE IF NOT EXISTS game_rounds (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  game TEXT NOT NULL,
  stake_cents INTEGER NOT NULL,
  reels TEXT NOT NULL,           -- JSON array of symbol indexes
  mult REAL NOT NULL,
  payout_cents INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rounds_user ON game_rounds(user_id, id);
CREATE TABLE IF NOT EXISTS bet_legs (
  id INTEGER PRIMARY KEY,
  bet_id INTEGER NOT NULL REFERENCES bets(id),
  event_id TEXT NOT NULL, market TEXT NOT NULL, sel TEXT NOT NULL,
  label TEXT NOT NULL, match TEXT NOT NULL, odds REAL NOT NULL,
  result TEXT                    -- won | lost once settled
);

-- The one bank account a player's withdrawals are paid to. Only the last 4 digits are kept.
CREATE TABLE IF NOT EXISTS payout_accounts (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  bank TEXT NOT NULL,
  holder TEXT NOT NULL,
  last4 TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL,          -- review | approved | sent | paid | failed | declined
  auto INTEGER NOT NULL,         -- 1 = approved by the automatic rules, 0 = checked by a person
  bank TEXT NOT NULL, last4 TEXT NOT NULL,
  reason TEXT,                   -- why it needed a check, failed or was declined
  created_at INTEGER NOT NULL,
  approved_at INTEGER, sent_at INTEGER, paid_at INTEGER,
  closed_at INTEGER              -- when it reached paid, failed or declined
);
CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON withdrawals(user_id, id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status);
`;

// Columns added after the first release. CREATE TABLE IF NOT EXISTS leaves an existing table alone,
// so a database made by an older version gets them here, keeping all its data.
const ADDED_COLUMNS = [
  ['users', 'deposit_limit_pending_cents', 'INTEGER'],
  ['users', 'deposit_limit_pending_at', 'INTEGER'],
  ['users', 'break_until', 'INTEGER'],
];

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  for (const [table, column, type] of ADDED_COLUMNS) {
    const has = db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
    if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
  return db;
}

// Run fn inside an IMMEDIATE transaction (takes the write lock up-front, so
// balance checks and writes can't interleave with another request).
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
