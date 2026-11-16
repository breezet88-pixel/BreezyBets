# Payments: decision, bank coverage and what must be confirmed

_Researched from public web pages (several are vendor marketing). Nothing here replaces a written answer from the provider._

## Decision

**Primary: Peach Payments.  Reference / backup: Stitch.**  Sign with Peach **only if** it confirms the three things under "Decision rule" in writing; otherwise Stitch becomes the primary for pay-by-bank and PayShap, with Peach (or another acquirer) for cards only.

| Role | Provider | Why |
|---|---|---|
| Primary | **Peach Payments** | One integration for cards, pay by bank, Capitec Pay and payouts; a dedicated [betting offering](https://www.peachpayments.com/betting) and a [high-risk programme](https://www.peachpayments.com/scale/high-risk-industries) that lists gambling/betting; payouts by batch same-day, [real-time clearance (since Aug 2025)](https://www.peachpayments.com/scale/peach-payments-announces-real-time-clearance-payouts/) and PayShap, per its [payout terms](https://www.peachpayments.com/hubfs/PayOuts%20%28SDV%2c%20RPP%20and%20RTC%29.pdf), with beneficiary bank-account verification. |
| Reference / backup | **Stitch** | The only provider that **publishes** its bank list ([pay by bank](https://www.stitch.money/pay-by-bank)); certified Capitec Pay provider; PayShap Request; payouts over any rail; says it serves large South African gaming/betting companies (its own claim). |
| Also quote | Ozow, Paystack ZA, Payfast | Ozow's [FAQ](https://ozow.com/faq) lists the widest banks but I found no Ozow statement about betting merchants. |

### Decision rule (what Peach must confirm in writing)
1. A **named bank list for pay by bank** that includes at least Absa, Capitec, Discovery, FNB, Investec, Nedbank, Standard Bank, TymeBank and African Bank.
2. **Capitec Pay is approved for a bookmaker** (see the verified-ID requirement below).
3. **Payouts reach every South African bank account** (batch same-day), plus which banks get real-time clearance / PayShap.

## "Compatible with all South African banks": what is and isn't known

No single provider or method reaches every bank; coverage comes from **combining rails**.

| Rail | What the public evidence says | Status |
|---|---|---|
| Pay by bank: Stitch | Absa, FNB, Standard Bank, Nedbank, TymeBank, Investec; Capitec via Capitec Pay; **Discovery on one version of its page** | Published |
| Pay by bank: Ozow | Capitec, FNB, Standard Bank, Absa, Nedbank, TymeBank, Investec, **Bidvest, African Bank**; Discovery not listed | Published (no betting statement) |
| Pay by bank: **Peach** | Its [page](https://www.peachpayments.com/pay-with/pay-by-bank/) says "the majority of banks" **without naming them**; its [changelog](https://developer.peachpayments.com/changelog/payment-methods) says Capitec Pay was added in 2023 and Pay by Bank in 2024 | **Not public: get it in writing** |
| **Capitec Pay** | Capitec classes each merchant as high or low risk. **High-risk merchants must send a verified RSA ID number, and only through the hosted/embedded checkout or payments API** (not payment links, payment pages or plugins). No official statement says whether betting counts as high risk. | **Confirm with Peach/Capitec** |
| Cards | Any bank's Visa/Mastercard; some banks may decline gambling merchant codes (weak, affiliate-site evidence) | Confirm decline rates |
| Payouts: Peach | Batch same-day, real-time clearance, PayShap; public [docs](https://developer.peachpayments.com/docs/peach-payouts) name Standard Bank, Nedbank, FNB, Old Mutual Bank, Access Bank and African Bank as destinations (likely a partial list) | Get the full list |
| PayShap | 12 participating banks (Stitch, 2026), including Discovery; per-transaction limits apply | Confirm Peach's coverage |

**Practical meaning:** deposits by pay-by-bank + Capitec Pay + cards cover essentially every customer (cards are the catch-all); withdrawals by EFT reach any account, with PayShap/real-time clearance where the bank takes part.

**Build consequence:** for Capitec Pay we will need each customer's **verified RSA ID number** at sign-up (FICA needs it anyway), and the payment must go through the provider's API checkout, not a payment link or plugin.

## Email to send to Peach Payments (and the same to Stitch)

> Subject: Merchant application: licensed South African online bookmaker (sports betting)
>
> We are applying for a [Western Cape/Gauteng/…] provincial bookmaker licence for an online sportsbook (sports and racing only, no casino games). Please confirm **in writing**:
> 1. Do you onboard licensed South African bookmakers? Which licence and FICA documents do you need, and how long does onboarding take?
> 2. For pay by bank / instant EFT: the **exact list of supported banks**, specifically Absa, Capitec, Discovery, FNB, Investec, Nedbank, Standard Bank, TymeBank, African Bank, Bidvest.
> 3. Is **Capitec Pay** available to a bookmaker, and do you treat us as high risk? Which integrations support it (we plan to use your API checkout and pass a verified RSA ID)?
> 4. For card payments: how are gambling merchant category codes handled, and what are typical decline rates by issuing bank?
> 5. For payouts: which rails (batch same-day, real-time clearance, PayShap), which banks on each, per-transaction limits, beneficiary verification, and cost per payout.
> 6. Fees, rolling reserve, settlement schedule and chargeback handling for a high-risk merchant.
> 7. Technical: sandbox access, webhook signing, idempotency keys, refund API.

## Order of work (the provider will not onboard before step 1)

1. **Provincial bookmaker licence** (sports/racing only: online casino games are not allowed in South Africa).
2. FICA/KYC process and provider (captures and verifies the RSA ID number).
3. Provider account, sandbox keys, written answers to the email above.
4. Build the integration: pending deposits, signed webhooks, idempotent crediting through the wallet ledger, withdrawal requests with manual review, deposit-limit checks. The demo deposit stays demo-only.

## Already in the code

- `DEMO_MODE=false` turns off the demo deposit, simulated settlement and the simulated bank; deposits and withdrawals then answer "no payment provider" until one is connected.
- **The withdrawal flow is built** (`server/withdrawals.js`): bank account, automatic approval up to R5 000, wallet debited on request, every step tracked, failed payouts returned. The provider replaces one function: on approval call its payout API with the withdrawal id as the idempotency key, and let its signed webhook mark the payout paid or failed.
- **Casino-style games are demo-only:** `GAMES_ENABLED` defaults to the value of `DEMO_MODE`, so real-money mode has no games unless an owner explicitly sets `GAMES_ENABLED=true`.
