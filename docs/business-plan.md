# ApexBets — Business Plan (DRAFT for the bookmaker licence application)

> **How to use this.** This is a working draft. Everything in **[SQUARE BRACKETS]** needs a real answer from you or your accountant; everything else is written and describes the business and platform as actually built. It is written for a Western Cape Gambling and Racing Board (WCGRB) online bookmaker licence application. It is **not** legal or financial advice — have your gambling lawyer and accountant review and finalise it before filing. The first enquiry email to the board does **not** need the full plan; this is the document the application itself will require, and a one-paragraph summary of it can go in the email.
>
> **Status note for honesty:** the platform today is a play-money demonstration. This plan describes the intended **licensed, real-money** operation and the steps required to get there. The betting system must pass SANS 1718 certification before any real money is taken; our own code is not yet certified.

---

## 1. Executive summary

ApexBets will be an online fixed-odds **sports and racing bookmaker** serving customers across South Africa, operated by **[REGISTERED COMPANY NAME] (Pty) Ltd** under a bookmaker licence from the Western Cape Gambling and Racing Board. The business offers betting on local and international sport (soccer including the PSL, rugby, cricket, tennis and basketball) through a mobile-first website, in English. It does **not** offer online casino games, which remain unlawful in South Africa.

The platform has been built compliance-first: a double-entry wallet ledger that keeps player money separate from the business, server-side control of all odds and bets, identity-verification-ready registration, and responsible-gambling tools (deposit limits, self-imposed breaks, a plain monthly spending statement) built into sign-up rather than buried. The business will reach real-money operation only after: a bookmaker licence, SANS 1718 platform certification, a FICA/KYC provider, a licensed payment provider, and the required banking and compliance set-up.

- **Legal entity:** [REGISTERED COMPANY NAME] (Pty) Ltd, registration [CIPC NUMBER], registered office [ADDRESS].
- **Licence sought:** Western Cape bookmaker licence (online), plus the required premises and key-employee licences.
- **Owners / directors:** [NAMES, ROLES, % HOLDINGS — see section 7].
- **Start-up capital:** approximately **[AMOUNT] ZAR**, from **[SOURCE OF FUNDS]**.
- **Target launch:** **[MONTH/YEAR]**, subject to licensing and certification.

## 2. The business and its purpose

- **Trading name:** ApexBets.
- **What it does:** takes fixed-odds bets on sport and racing, online only, from customers aged 18+ who pass FICA identity verification.
- **Why it exists / positioning:** a simpler, faster, more transparent sportsbook than the incumbents — a bet in three taps, clear withdrawals paid quickly with a visible tracker, deposit limits chosen at sign-up, and a plain "this month you are up/down R…" statement. (The competitive reasoning is in `docs/competitive-analysis.md`.)
- **Language:** English only.
- **What it will not do:** no online casino, slots, roulette or bets on lottery outcomes — these are outside a bookmaker licence and unlawful.

## 3. Market and competitors

The South African online betting market is large and growing: gambling revenue was about R75 billion in 2024/25, of which betting was roughly R52 billion and still growing by around 44% a year. The market is dominated by Betway and Hollywoodbets, with room for smaller, differentiated challengers (EasyBet and 10bet have grown as newcomers). ApexBets competes not on advertising spend — which it cannot match — but on **payout certainty, transparency, responsible-gambling design and a light, low-data site**. Full market evidence and sources are in `docs/competitive-analysis.md`.

- **Target customer:** [DESCRIBE — e.g. mobile-first South African sports bettors, age range, typical stake. The research suggests most bettors are low-stake and on phones.]
- **Our edge:** fast, tracked withdrawals; limits and a spending statement built in; a site that uses very little mobile data (measured at ~0.3 MB/hour watching a live match); English-only simplicity.

## 4. The product and operations

- **Platform:** a mobile-first web app (no download needed). Built in-house with server-authoritative odds and bet acceptance; a double-entry, append-only wallet ledger in integer cents that keeps player balances separate from business funds and is fully auditable.
- **Certification:** before launch the platform will be certified to **SANS 1718**. [DECISION NEEDED — see question in the message: build-and-certify our own platform, or run on a certified third-party platform and keep our front end. This materially changes cost and timeline.]
- **Odds and results:** [FILL: licensed data/odds feed supplier intended, e.g. a Sportradar-type feed — to be selected. Today the demo uses sample data.]
- **Payments:** deposits and withdrawals via a licensed South African payment provider (Peach Payments / Stitch under evaluation — see `docs/payments.md`), supporting cards, pay-by-bank and Capitec Pay. Withdrawals are paid to the customer's own verified bank account.
- **Hosting:** cloud hosting in the Johannesburg region (see `docs/hosting.md`), HTTPS only, daily database backups.
- **Customer support:** [FILL: how customers get help — email, WhatsApp, hours, who staffs it.]

## 5. Responsible gambling and regulatory compliance

Compliance is built into the product, not added on:

- **Age and identity (FICA/KYC):** registration requires date of birth (18+ enforced) and will require RSA ID verification and source-of-funds checks before deposits or withdrawals, via [FILL: verification provider, to be selected].
- **Responsible gambling:** every new customer sets a **daily deposit limit** at sign-up (or explicitly chooses no limit); lowering a limit is immediate, raising it waits out a cooling-off period; customers can take a **self-imposed break** (24 hours, 7 or 30 days) that cannot be shortened; a plain **monthly spending statement** shows deposits, withdrawals and whether they are up or down. The South African Responsible Gambling Foundation helpline (0800 006 008) is shown throughout.
- **Self-exclusion:** integration with the National Register of Excluded Persons. [FILL: to be implemented per the board's current requirements.]
- **Anti-money-laundering:** a play-through rule requires deposited funds to be bet before they can be withdrawn; all money movements are recorded in the append-only ledger; suspicious transactions will be reported as required. The business will register with the FIC as an accountable institution. [CONFIRM with lawyer.]
- **Data protection (POPIA):** [FILL: appoint an Information Officer; privacy policy; data stored in South Africa per the regulator's data-location notice.]
- **Protecting vulnerable customers:** [FILL: approach to SASSA/NSFAS-funded customers, per the industry guard-rail discussions — decide your policy with the lawyer.]

## 6. Risk management

- **Trading/liability risk:** [FILL: limits per bet and per market, who sets prices/manages risk — in-house trader or managed-trading service from the data supplier.]
- **Regulatory risk:** a call for a moratorium on new bookmaker licences was raised in 2026; a 20% national online-gambling tax is proposed for decision in Feb 2027. The plan assumes neither blocks entry but both are monitored. (See `docs/licence.md`.)
- **Fraud/chargebacks:** handled via the payment provider's controls plus manual review of large withdrawals.
- **Technical:** single-region hosting with daily backups; the site is tested (automated test suite covering accounts, wallet, betting and withdrawals).

## 7. Ownership and management

- **Shareholders:** [FILL: each owner, % holding, ID/passport, nationality and residency. The board does a probity check on anyone holding 5%+.]
- **B-BBEE:** [FILL: current status / intended ownership structure — discuss with the lawyer; it affects the application.]
- **Directors / key people:** [FILL: names, roles, relevant experience. Key staff need their own key-employee licences.]
- **Compliance officer:** [FILL: who is responsible for FICA/RG/POPIA compliance.]

## 8. Financial plan

> Fill this section with your accountant. Do not use invented figures in a regulatory document.

- **Start-up costs:** licence fees (~R16,343 application + R31,982 refundable deposit + ~R16,400/year, per current WCGRB guidance), legal fees [QUOTE], platform build/certification [QUOTE], data feed [QUOTE], payment integration, hosting, working capital to cover early payouts. **Total: [FILL].**
- **Funding:** [FILL: how much, from whom, proof of source of funds — the board requires this.]
- **Revenue model:** gross gaming revenue = stakes received minus winnings paid, from the margin built into the odds (around 6% on the main markets).
- **Costs against revenue:** provincial betting levy (~6–9% of GGR), 15% VAT, company income tax, ~0.1% responsible-gambling contribution, payment and platform fees, staff. (See `docs/operator-payouts.md`.)
- **Projections:** [FILL WITH ACCOUNTANT: customers, average stake, monthly turnover, GGR, break-even — 12–36 month view. Keep assumptions explicit.]

## 9. Timeline

[FILL / confirm — indicative]

1. Board enquiry answered; lawyer engaged.
2. Company, bank account, ownership structure finalised.
3. Platform certification + data feed + payment provider contracted.
4. Application, premises and key-employee applications filed; fees paid.
5. Probity investigation.
6. Licence granted → FICA, payments and real-money mode switched on → launch.

---

*Prepared as a working draft. Figures and company facts to be completed by the owner and verified by a gambling lawyer and an accountant before submission.*
