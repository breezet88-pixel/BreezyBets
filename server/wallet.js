// Wallet ledger operations. All amounts are integer cents. Call inside tx().
export class WalletError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export const userAccount = id => `user:${id}`;

export function balance(db, account) {
  return db.prepare('SELECT COALESCE(SUM(amount_cents),0) AS b FROM ledger_entries WHERE account = ?').get(account).b;
}

// entries: [{account, amount}] – must sum to exactly zero. User wallets may not go negative.
export function post(db, { kind, userId = null, ref = null, entries }) {
  if (!entries.length || entries.reduce((s, e) => s + e.amount, 0) !== 0) throw new WalletError('unbalanced', 'ledger transaction must balance');
  if (!entries.every(e => Number.isInteger(e.amount) && e.amount !== 0)) throw new WalletError('bad_amount', 'amounts must be non-zero integer cents');
  for (const e of entries) {
    if (e.account.startsWith('user:') && e.amount < 0 && balance(db, e.account) + e.amount < 0) {
      throw new WalletError('insufficient_funds', 'Insufficient balance');
    }
  }
  const { lastInsertRowid: txn } = db.prepare('INSERT INTO ledger_txns (kind,user_id,ref,created_at) VALUES (?,?,?,?)').run(kind, userId, ref, Date.now());
  const ins = db.prepare('INSERT INTO ledger_entries (txn_id,account,amount_cents) VALUES (?,?,?)');
  for (const e of entries) ins.run(txn, e.account, e.amount);
  return Number(txn);
}

// Convenience: move money between a house account and a user wallet.
export const credit = (db, userId, kind, source, cents, ref) =>
  post(db, { kind, userId, ref, entries: [{ account: source, amount: -cents }, { account: userAccount(userId), amount: cents }] });
export const debit = (db, userId, kind, sink, cents, ref) =>
  post(db, { kind, userId, ref, entries: [{ account: userAccount(userId), amount: -cents }, { account: sink, amount: cents }] });

// South African day boundary (SAST = UTC+2, no DST) for daily deposit limits.
export function sastDayStart(now = Date.now()) {
  const off = 2 * 36e5;
  return Math.floor((now + off) / 864e5) * 864e5 - off;
}
export function depositedToday(db, userId, now = Date.now()) {
  return db.prepare("SELECT COALESCE(SUM(e.amount_cents),0) AS s FROM ledger_txns t JOIN ledger_entries e ON e.txn_id=t.id AND e.account=? WHERE t.user_id=? AND t.kind='deposit' AND t.created_at>=?")
    .get(userAccount(userId), userId, sastDayStart(now)).s;
}
// Integrity check: every transaction sums to zero.
export function unbalancedTxns(db) {
  return db.prepare('SELECT txn_id FROM ledger_entries GROUP BY txn_id HAVING SUM(amount_cents) != 0').all();
}
