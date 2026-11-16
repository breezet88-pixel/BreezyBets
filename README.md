# ApexBets (demo)

A South African–style online sportsbook and games site: six predator-themed **Apex Games** (Lion's Pride, Tiger Stripes,
Grizzly Gold, Eagle Eye, Wolf Pack, Shark Frenzy) plus a sportsbook (PSL soccer, URC/Test rugby, SA20 cricket, tennis, basketball).
**Demo only: play money, sample fixtures, simulated odds. No real payments or real bets.**

## Run
Requires Node 22.13+ (zero npm dependencies; uses built-in `node:sqlite`).

```
npm start          # http://localhost:3000   (PORT, DB_PATH, DEMO_MODE=false, GAMES_ENABLED, NODE_ENV=production are supported)
npm test           # API, wallet-ledger, game-RTP and hardening tests (no browser needed)
npm run e2e        # browser end-to-end run (needs Playwright installed: drives every page, all 6 games, bets, deposits, mobile)
```

## Architecture
- `server/odds.js` – odds engine (sample data). The server decides prices; bets with stale odds get `409 odds_changed`.
- `server/wallet.js` – **double-entry ledger**: integer cents, every transaction sums to zero, player wallets can't overdraw,
  and SQLite triggers make the ledger append-only. Balances are derived from the ledger, never stored.
- `server/auth.js` – scrypt password hashing, random session tokens (only SHA-256 hashes stored), HttpOnly + SameSite=Strict cookies,
  login/sign-up rate limiting, server-side 18+ check.
- `server/games.js` – the six games: CSPRNG outcomes, exact RTP (~95%) verified in tests.
- `server/safety.js` – player protection: limit changes with a cooling-off period, breaks, the monthly statement, and the play-through rule.
- `server/server.js` – JSON API + static hosting with a strict CSP; text responses are gzipped (first visit about 18 KB, an hour of live odds about 1 MB).
- `public/` – the browser app (display only; no odds, balances or RNG in the browser).

## How the site is organised (kept deliberately simple)
- **Three places to go:** Sports, My Bets, Games – a top bar on desktop, a bottom bar on phones. The address (`#/sports/soccer`, `#/my-bets`, `#/games`) always says where you are and the Back button works.
- **One path to a bet:** pick a sport tab → tap a price (1 / X / 2) → type a stake → *Place bet*. Matches show only their main market.
- **The bet slip stays out of the way:** it appears beside the matches (desktop) or as a bar that only shows once you've picked something (phone). One pick = a single; two or more default to a Multiple, with one switch to Singles.
- **No surprises:** a finished bet shows a clear confirmation with *View my bets*; problems (minimum stake, low balance, changed prices) appear on the slip itself with the fix next to them; a new bet always starts from the default R50 stake.
- Prices, clocks and scores refresh **in place**, so the price under your finger never moves or disappears mid-tap.

## Features
- Sports menu, live events with simulated score/odds movement, 1X2 / winner / over-under markets
- Bet slip: singles and multiples, stake presets, potential return, one selection per match in multiples
- Real accounts (username + password), 18+ check, play-money deposits, daily deposit limit enforced on the server, wallet statement
- My Bets with simulated settlement (`/api/bets/settle-demo`, disabled when `DEMO_MODE=false`)
- **Staying in control** (see `server/safety.js`):
  - every new player chooses a daily deposit limit at sign-up (including an explicit "No limit");
  - lowering a limit applies at once, raising or removing it waits 24 hours (`LIMIT_COOLOFF_HOURS`) and can be cancelled;
  - a break of 24 hours, 7 days or 30 days pauses deposits, bets and games, cannot be ended early, and is shown on every page;
  - **My spending**: a plain monthly statement (staked, got back, deposited, withdrawn, "you are down/up R…") read straight from the ledger.
- Responsible-gambling footer and SARGF helpline (0800 006 008)
- Responsive: phone layout with bottom navigation and a bet-slip sheet

## Going to production: what a real site needs
1. **Licence**: operate only with a provincial gambling board bookmaker licence (National Gambling Act); geo-block/age-gate accordingly.
2. **FICA/KYC**: RSA ID verification, proof of address, sanctions/PEP checks, self-exclusion integration.
3. **Backend**: server-side bet acceptance, wallet ledger (double-entry), authentication (hashed passwords, 2FA), audit logs. Never trust client-side odds or balances (this demo does, deliberately).
4. **Odds & results**: licensed data feed (e.g. Sportradar, Betradar, Genius) plus a trading/risk engine.
5. **Payments**: PCI-compliant provider (EFT, cards, Ozow, vouchers), withdrawals, fraud checks.
6. **Compliance**: tax handling, responsible-gambling tools (limits, cool-off, reality checks), data protection (POPIA).

## Cashback / loss-rebate model
`node tools/cashback-model.mjs [players=2000] [days=300] [keep=0.5]` simulates whole days of play on the six games and shows how large a
loss-rebate promise can be while the house keeps at least `keep` (default 50%) of each day's gross gaming revenue.

## Payments and going live
See [`docs/payments.md`](docs/payments.md): chosen provider (Peach Payments, with Stitch as backup), how "all banks" is actually covered, the questions to put to the provider in writing, and the order of work. Casino-style games are demo-only: in real-money mode (`DEMO_MODE=false`) they are switched off unless `GAMES_ENABLED=true` is set deliberately.

## Competitive research
See [`docs/competitive-analysis.md`](docs/competitive-analysis.md): the South African market, what rivals already do, the gaps where a newcomer can be better, where we are at a disadvantage, and what a real licensed launch requires.
