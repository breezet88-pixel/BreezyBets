# How you, as the owner, get paid from a licensed sportsbook

_This is the lawful answer to "how do I get my money out." It is information, not legal or tax advice. Confirm everything with a South African accountant and a gambling lawyer before you rely on it. Figures are from the research in `docs/competitive-analysis.md` and `docs/payments.md`._

## The one thing to understand

Your income as the operator is **gross gaming revenue (GGR)**: the stakes players place, minus the winnings you pay them. On a fair book this is positive over time because the odds carry a margin. That money is the business's, and it already belongs to you as the owner — you do not need to bet, win, or disguise anything to receive it.

**The money lives in the business bank account, never in a player wallet.** A player wallet is money the site owes that player. The two are kept apart on purpose, and the audit ledger in this codebase (`server/wallet.js`) exists so a regulator or auditor can prove they were never mixed.

## How you actually take the money

1. **Players deposit and bet.** Their deposits and any winnings sit in player wallets (a liability of the business).
2. **GGR settles to the business account.** What is left after winnings are paid is revenue. A real payment provider settles this to your company bank account on its normal schedule.
3. **You pay yourself from the company**, the same as any other business:
   - a **salary** as a director/employee (PAYE applies), and/or
   - a **dividend** out of after-tax profit (dividends tax applies).
   - Both move through ordinary company banking, with a record of what each payment is.
4. **You declare it** to SARS. There is **no R5,000/day cap** on this — that cap is a *player* withdrawal limit. Your profit is limited only by what the business actually earns.

## What comes off the top first (so you know what "profit" really is)

Before anything reaches you, the business pays:

| Cost | Reported level |
|---|---|
| Provincial betting levy | about 6–9% of GGR |
| VAT | 15% |
| Possible national online-gambling tax | 20% of GGR, proposed, decision due Feb 2027 |
| Company income tax | on profit, normal rates |
| Responsible-gambling contribution | ~0.1% of GGR in some provinces |
| Running costs | platform/data feed, payment fees, licence fees, staff, support |

These are the figures from earlier research and they move; an accountant will give you the current numbers. The point is that "accumulated money on the site" is **not** your profit — most of it is players' balances, tax, and costs. Your profit is the slice left after all of the above.

## Why the "disguise withdrawals as winnings" idea fails, in one line each

- **It's not your money to take that way.** Player balances are a liability; pulling them out as fake winnings is theft from players and the business.
- **It's money laundering.** Fabricating bets to move money and dress it as winnings is a criminal offence; the FICA/KYC, audit ledger, and suspicious-transaction reporting are built to detect exactly this.
- **Operators can't bet on their own book.** Licence conditions forbid it precisely so results can't be arranged.
- **It's unnecessary.** The honest route above gets you *more* money (no R5,000 cap) with none of the risk.

Doing it would cost you the licence and expose you to prosecution. There is no version of it I will build.

## The gates before any real money moves — in order

Nothing below can be skipped, and the site stays in demo (`DEMO_MODE=true`) until all of them are done.

1. **Licence.** Hold a valid provincial bookmaker licence (`docs/licence.md`).
2. **Certified platform.** The betting system must pass SANS 1718 certification. Our own code is not certified; realistically this means launching on a certified platform and keeping our front end only if the supplier allows it.
3. **FICA/KYC live.** Verify every player's identity and source of funds before they can deposit or withdraw.
4. **Payment provider signed** (`docs/payments.md`), with the real deposit/withdrawal integration wired in and tested.
5. **Written host approval.** Ask Fly (or whichever host) in writing whether a licensed real-money sportsbook is acceptable, and keep the reply (`docs/hosting.md`).
6. **Business banking + accounting set up** so GGR settles to the company and payouts to players and to you are recorded and taxed.

Only after 1–6 do you set `DEMO_MODE=false`. Before then, taking real bets is itself illegal, regardless of hosting.

## What I can do now vs. what waits

- **Now:** this explainer; the licence guidance and the board email; the payment-provider plan and questions; keeping the build correct and tested in demo mode.
- **Waits for the licence + certified platform + provider:** switching off demo mode, and wiring the real payment integration so players' real deposits and withdrawals work. I'll build those when the gates are met — not before.
