// Player protection: daily deposit limits with a cooling-off period, breaks, the plain monthly
// statement, and the rule for how much of a balance may be withdrawn.
// Everything about money is read from the ledger, so these figures can never drift from the wallet.
import { userAccount } from './wallet.js';

export const BREAK_HOURS = [24, 168, 720];                 // 1 day, 7 days, 30 days
const SAST = 2 * 36e5;                                     // South Africa is UTC+2 all year

/* ---------- deposit limit ---------- */

// 0 means "no limit", so it is the loosest value there is.
export const isLooser = (next, current) => current !== 0 && (next === 0 || next > current);

// Apply a pending increase once its cooling-off time has passed. Returns the up-to-date user row.
export function settleLimit(db, user, now = Date.now()) {
  if (user.deposit_limit_pending_at == null || user.deposit_limit_pending_at > now) return user;
  db.prepare('UPDATE users SET deposit_limit_cents=?, deposit_limit_pending_cents=NULL, deposit_limit_pending_at=NULL WHERE id=?')
    .run(user.deposit_limit_pending_cents, user.id);
  return { ...user, deposit_limit_cents: user.deposit_limit_pending_cents, deposit_limit_pending_cents: null, deposit_limit_pending_at: null };
}

// Lowering a limit is instant. Raising or removing one waits out the cooling-off period,
// so a decision made in the heat of the moment cannot take effect straight away.
export function changeLimit(db, user, next, coolOffMs, now = Date.now()) {
  if (isLooser(next, user.deposit_limit_cents)) {
    const at = now + coolOffMs;
    db.prepare('UPDATE users SET deposit_limit_pending_cents=?, deposit_limit_pending_at=? WHERE id=?').run(next, at, user.id);
    return { ...user, deposit_limit_pending_cents: next, deposit_limit_pending_at: at };
  }
  db.prepare('UPDATE users SET deposit_limit_cents=?, deposit_limit_pending_cents=NULL, deposit_limit_pending_at=NULL WHERE id=?').run(next, user.id);
  return { ...user, deposit_limit_cents: next, deposit_limit_pending_cents: null, deposit_limit_pending_at: null };
}

/* ---------- breaks ---------- */

export const onBreak = (user, now = Date.now()) => !!user.break_until && user.break_until > now;

// A break can be extended but never shortened or cancelled.
export function startBreak(db, user, hours, now = Date.now()) {
  const until = Math.max(user.break_until || 0, now + hours * 36e5);
  db.prepare('UPDATE users SET break_until=? WHERE id=?').run(until, user.id);
  return { ...user, break_until: until };
}

/* ---------- reading the ledger ---------- */

// Totals of a player's wallet movements by kind, optionally within a time window.
function totalsByKind(db, userId, from = 0, to = Number.MAX_SAFE_INTEGER) {
  const rows = db.prepare(`SELECT t.kind AS kind, SUM(e.amount_cents) AS total, COUNT(*) AS n
    FROM ledger_entries e JOIN ledger_txns t ON t.id = e.txn_id
    WHERE e.account = ? AND t.created_at >= ? AND t.created_at < ? GROUP BY t.kind`).all(userAccount(userId), from, to);
  const by = Object.fromEntries(rows.map(r => [r.kind, r]));
  return kind => by[kind] || { total: 0, n: 0 };
}

export const currentMonth = (now = Date.now()) => new Date(now + SAST).toISOString().slice(0, 7);
export const isMonth = s => /^\d{4}-(0[1-9]|1[0-2])$/.test(s || '');
const monthBounds = ym => { const [y, m] = ym.split('-').map(Number); return [Date.UTC(y, m - 1, 1) - SAST, Date.UTC(y, m, 1) - SAST]; };

// The monthly statement: money in, money out, and the plain result of play. Months are South African time.
export function statement(db, userId, month, now = Date.now()) {
  const [from, to] = monthBounds(month), k = totalsByKind(db, userId, from, to);
  const staked = -(k('bet_stake').total + k('game_stake').total);
  const returned = k('bet_payout').total + k('game_win').total;
  const months = db.prepare(`SELECT DISTINCT strftime('%Y-%m', t.created_at / 1000 + 7200, 'unixepoch') AS m
    FROM ledger_entries e JOIN ledger_txns t ON t.id = e.txn_id WHERE e.account = ? ORDER BY m DESC`).all(userAccount(userId)).map(r => r.m);
  const cur = currentMonth(now); if (!months.includes(cur)) months.unshift(cur);
  return {
    month, months,
    deposited_cents: k('deposit').total,
    bonus_cents: k('bonus').total,
    withdrawn_cents: -(k('withdrawal').total + k('withdrawal_returned').total),   // paid or on its way, less anything sent back
    staked_cents: staked,
    returned_cents: returned,
    result_cents: returned - staked,                                              // negative = the player is down
    bets: k('bet_stake').n,
    game_rounds: k('game_stake').n,
  };
}

// Money that came in must be bet once before it can leave. This is the usual anti-money-laundering
// rule for bookmakers: without it an account could be used to move money without gambling at all.
// Winnings are always withdrawable.
export function playThrough(db, userId, balanceCents) {
  const k = totalsByKind(db, userId);
  const moneyIn = k('deposit').total + k('bonus').total;
  const staked = -(k('bet_stake').total + k('game_stake').total);
  const unplayed = Math.max(0, moneyIn - staked);
  return { unplayed_cents: unplayed, withdrawable_cents: Math.max(0, balanceCents - unplayed) };
}
