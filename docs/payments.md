# Payments: decision, bank coverage and what to confirm

_Researched from public web pages (several are vendor marketing). Nothing here replaces a written answer from the provider._

## Decision

| Role | Provider | Why |
|---|---|---|
| **Primary** | **Peach Payments** | One integration for cards, Instant EFT, Capitec Pay and payouts; has a dedicated [betting offering](https://www.peachpayments.com/betting) and lists gambling/betting under its [high-risk programme](https://www.peachpayments.com/scale/high-risk-industries); payouts as [same-day, next-day or instant](https://www.peachpayments.com/products/payouts) with bank-account verification. Its Instant EFT was [built with Stitch](https://stitch.money/blog/peach-payments-partners-with-stitch-to-launch-instant-eft-checkouts-for-merchants-across-south-africa), so Stitch's bank list applies. |
| **Backup / add-on** | **Stitch** (direct) | Publishes its bank list ([pay by bank](https://www.stitch.money/pay-by-bank)), certified Capitec Pay provider, [PayShap Request](https://stitch.money/payment-methods/payshap-request), payouts over any available rail, and says it serves large South African gaming/betting companies. |
| Alternatives to quote | Ozow, Paystack ZA, Payfast | Ozow lists the widest banks ([FAQ](https://ozow.com/faq)) but I found no Ozow statement about betting merchants. [Paystack](https://paystack.com/za/betting) and [Payfast](https://payfast.io/industries/gaming-and-betting-industry/) both market to betting. |

## "Compatible with all South African banks": what can honestly be promised

No single provider or payment method reaches every bank. Coverage comes from **combining rails**:

| Rail | Used for | Banks covered (per provider pages) | Status |
|---|---|---|---|
| Pay by bank / Instant EFT | Deposits | Absa, FNB, Standard Bank, Nedbank, TymeBank, Investec. Capitec via **Capitec Pay**. Ozow also lists Bidvest Bank and African Bank. | Sources agree on the big six. **Discovery Bank: sources disagree.** |
| Capitec Pay | Deposits (Capitec is the largest retail bank) | Capitec | **Peach lists gambling among "high-risk" industries for Capitec Pay: confirm it is allowed for a bookmaker.** |
| Cards (Visa/Mastercard) | Deposits, universal fallback | Any bank's card | Some banks may decline gambling merchant codes; evidence is weak (affiliate sites). Licensed local operators are reportedly less affected. Confirm decline rates. |
| Bank EFT (batch / same-day) | **Withdrawals** | Any South African bank account | General banking fact: confirm provider's payout rails and cost. |
| PayShap | Instant withdrawals / pay-ins | The participating banks (Stitch cites 12 in 2026) | Per-transaction limits apply (R3 000 at launch). Not confirmed for Peach. |

**Practical meaning:** deposits via pay-by-bank + Capitec Pay + cards cover essentially every customer; withdrawals by EFT reach any account, with PayShap as the instant option where the bank participates.

## Ask the provider, in writing, before signing

1. Do you onboard **licensed South African bookmakers**? Which licence/FICA documents do you need?
2. **Exact bank list per method** (Instant EFT, Capitec Pay, cards): include Discovery, TymeBank, African Bank, Bidvest, Investec, Nedbank.
3. Is **Capitec Pay** allowed for betting merchants?
4. **Payouts:** rails (EFT batch, same-day, instant/PayShap), per-transaction limits, beneficiary-account verification, cost per payout.
5. **Fees, rolling reserve, settlement schedule, chargeback handling** for high-risk merchants.
6. Card acquiring: how do you handle gambling merchant codes, and what are typical decline rates by issuing bank?
7. Technical: sandbox keys, **webhook signing**, idempotency, refund API.

## Order of work (the provider will not onboard before step 1)

1. **Provincial bookmaker licence** (sports/racing only: online casino games are not allowed in South Africa).
2. FICA/KYC process and provider.
3. Provider account, sandbox keys, written answers to the questions above.
4. Build the integration: pending deposits, signed webhooks, idempotent crediting through the wallet ledger, withdrawal requests with manual review, deposit-limit checks. (The current demo deposit stays demo-only.)

## Already in the code

- `DEMO_MODE=false` turns off the demo deposit and simulated settlement.
- **Casino-style games are demo-only:** `GAMES_ENABLED` defaults to the value of `DEMO_MODE`, so real-money mode has no games unless an owner explicitly sets `GAMES_ENABLED=true`.
