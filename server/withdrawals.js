// Withdrawals: one bank account per player, automatic approval rules, and a payout that is tracked
// step by step so the player always knows where their money is.
//
// The bank side is SIMULATED. With a real payment provider, `advance()` goes away and:
//   - on approval, call the provider's payout API with the withdrawal id as the idempotency key  (-> 'sent')
//   - the provider's signed webhook then calls settle() for "paid" or giveBack() for "failed"
// The rules, the ledger movements and the tracker the player sees stay exactly as they are.
import { tx } from './db.js';
import { post, userAccount, balance } from './wallet.js';
import { playThrough } from './safety.js';
import { HttpError, bad } from './errors.js';

export const BANKS = ['Absa', 'African Bank', 'Bidvest Bank', 'Capitec', 'Discovery Bank', 'FNB', 'Investec', 'Nedbank', 'Standard Bank', 'TymeBank'];
export const MIN_WITHDRAWAL = 5000;                         // R50
const HOLD = 'house:withdrawals_pending';                   // money that has left a wallet and not yet reached a bank
const PAID_OUT = 'house:paid_out';                          // money that has left the business

export function createWithdrawals({ db, autoApproveMaxCents, sendMs, paidMs }) {
  const pub = w => ({ id: w.id, amount_cents: w.amount_cents, status: w.status, auto: !!w.auto, bank: w.bank, last4: w.last4, reason: w.reason,
    created_at: w.created_at, approved_at: w.approved_at, sent_at: w.sent_at, paid_at: w.paid_at, closed_at: w.closed_at });
  const one = id => db.prepare('SELECT * FROM withdrawals WHERE id=?').get(id);
  const ref = w => `withdrawal:${w.id}`;

  /* ---- ledger movements: the wallet is debited the moment a withdrawal is requested ---- */
  const hold = w => post(db, { kind: 'withdrawal', userId: w.user_id, ref: ref(w),
    entries: [{ account: userAccount(w.user_id), amount: -w.amount_cents }, { account: HOLD, amount: w.amount_cents }] });
  function settle(w, at) {
    post(db, { kind: 'withdrawal_paid', userId: w.user_id, ref: ref(w), entries: [{ account: HOLD, amount: -w.amount_cents }, { account: PAID_OUT, amount: w.amount_cents }] });
    db.prepare("UPDATE withdrawals SET status='paid', paid_at=?, closed_at=? WHERE id=?").run(at, at, w.id);
  }
  function giveBack(w, status, reason, at) {
    post(db, { kind: 'withdrawal_returned', userId: w.user_id, ref: ref(w), entries: [{ account: HOLD, amount: -w.amount_cents }, { account: userAccount(w.user_id), amount: w.amount_cents }] });
    db.prepare('UPDATE withdrawals SET status=?, reason=?, closed_at=? WHERE id=?').run(status, reason, at, w.id);
  }

  /* ---- the bank account winnings are paid to ---- */
  const accountRow = userId => db.prepare('SELECT * FROM payout_accounts WHERE user_id=?').get(userId);
  const account = userId => { const a = accountRow(userId); return a ? { bank: a.bank, last4: a.last4, holder: a.holder } : null; };
  const inProgress = userId => db.prepare("SELECT COUNT(*) AS n FROM withdrawals WHERE user_id=? AND status IN ('review','approved','sent')").get(userId).n;

  function saveAccount(userId, { bank, account_number: number, holder }, now = Date.now()) {
    if (!BANKS.includes(bank)) throw bad('Choose your bank from the list', 'bad_bank');
    if (typeof number !== 'string' || !/^\d{6,16}$/.test(number)) throw bad('Enter the account number: 6 to 16 digits', 'bad_account');
    if (typeof holder !== 'string' || !/^\p{L}[\p{L} .'-]{1,59}$/u.test(holder.trim())) throw bad('Enter the account holder’s name', 'bad_holder');
    // Changing where money goes while money is on its way is how stolen accounts are emptied.
    if (inProgress(userId)) throw new HttpError(409, 'withdrawal_in_progress', 'You can change your bank account once your current withdrawal has finished');
    // Only the last four digits are kept. Demo: marked as verified at once.
    // A real site first confirms with the bank that the account exists and belongs to this person.
    db.prepare(`INSERT INTO payout_accounts (user_id,bank,holder,last4,verified,created_at) VALUES (?,?,?,?,1,?)
      ON CONFLICT(user_id) DO UPDATE SET bank=excluded.bank, holder=excluded.holder, last4=excluded.last4, verified=1, created_at=excluded.created_at`)
      .run(userId, bank, holder.trim(), number.slice(-4), now);
    return account(userId);
  }

  /* ---- requesting a withdrawal: the automatic rules ----
     1. it goes to the player's own verified bank account;
     2. money put in has been bet once (see playThrough);
     3. up to the automatic amount it is approved at once, day or night; above it, a person checks it first.
     Rules 1 and 2 refuse with a reason the player can act on. Rule 3 never refuses: it only decides who approves. */
  function request(user, amount, now = Date.now()) {
    const acct = accountRow(user.id);
    if (!acct || !acct.verified) throw new HttpError(409, 'no_payout_account', 'Add your bank account first');
    if (!Number.isInteger(amount) || amount < MIN_WITHDRAWAL) throw bad(`The minimum withdrawal is R${MIN_WITHDRAWAL / 100}`, 'bad_amount');
    const bal = balance(db, userAccount(user.id)), { withdrawable_cents: can } = playThrough(db, user.id, bal);
    if (amount > bal) throw new HttpError(422, 'insufficient_funds', 'You don’t have that much in your balance');
    if (amount > can) throw new HttpError(422, 'not_played', `You can withdraw up to R${(can / 100).toFixed(2)} now. Money you put in must be bet once before it can be withdrawn.`);
    const auto = amount <= autoApproveMaxCents;
    const { lastInsertRowid } = db.prepare('INSERT INTO withdrawals (user_id,amount_cents,status,auto,bank,last4,reason,created_at,approved_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(user.id, amount, auto ? 'approved' : 'review', auto ? 1 : 0, acct.bank, acct.last4,
        auto ? null : `Withdrawals over R${autoApproveMaxCents / 100} are checked by a person first`, now, auto ? now : null);
    const w = one(Number(lastInsertRowid));
    hold(w);                                                // throws if the wallet cannot cover it
    return pub(w);
  }

  // The person who checks large withdrawals. In the demo the player presses the button themselves.
  function review(userId, id, approve, now = Date.now()) {
    const w = Number.isInteger(id) ? one(id) : null;
    if (!w || w.user_id !== userId || w.status !== 'review') throw new HttpError(404, 'not_found', 'No withdrawal is waiting for a check');
    if (approve) db.prepare("UPDATE withdrawals SET status='approved', approved_at=? WHERE id=?").run(now, id);
    else giveBack(w, 'declined', 'Declined after a check. The money is back in your balance.', now);
    return pub(one(id));
  }

  /* ---- the simulated bank: approved -> sent -> paid, on a fixed timetable ---- */
  function advance(now = Date.now()) {
    const due = db.prepare("SELECT * FROM withdrawals WHERE (status='approved' AND approved_at + ? <= ?) OR (status='sent' AND sent_at + ? <= ?)").all(sendMs, now, paidMs, now);
    if (!due.length) return 0;
    tx(db, () => {
      for (let w of due) {
        if (w.status === 'approved') {
          const at = w.approved_at + sendMs;
          db.prepare("UPDATE withdrawals SET status='sent', sent_at=? WHERE id=?").run(at, w.id);
          w = { ...w, status: 'sent', sent_at: at };
        }
        const at = w.sent_at + paidMs;
        if (at > now) continue;
        // Demo: an account number ending 0000 is rejected by the "bank", so the failure path can be seen and tested.
        if (w.last4 === '0000') giveBack(w, 'failed', 'Your bank rejected the payment. The money is back in your balance.', at);
        else settle(w, at);
      }
    });
    return due.length;
  }

  const list = userId => db.prepare('SELECT * FROM withdrawals WHERE user_id=? ORDER BY id DESC LIMIT 20').all(userId).map(pub);

  // What we publish: how long payouts really took over the last 30 days, from request to paid.
  function stats(now = Date.now()) {
    const rows = db.prepare("SELECT paid_at - created_at AS ms, auto FROM withdrawals WHERE status='paid' AND paid_at >= ? ORDER BY ms").all(now - 30 * 864e5);
    if (!rows.length) return { count: 0 };
    const at = q => rows[Math.min(rows.length - 1, Math.floor(q * rows.length))].ms;
    return { count: rows.length, median_seconds: Math.round(at(0.5) / 1000), p95_seconds: Math.round(at(0.95) / 1000), auto_share: rows.filter(r => r.auto).length / rows.length };
  }

  return { account, saveAccount, request, review, advance, list, stats };
}
