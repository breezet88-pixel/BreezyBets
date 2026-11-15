# ApexBets (demo)

A South African–style online sportsbook and games site: six predator-themed **Apex Games** (Lion's Pride, Tiger Stripes,
Grizzly Gold, Eagle Eye, Wolf Pack, Shark Frenzy) plus a sportsbook (PSL soccer, URC/Test rugby, SA20 cricket, tennis, basketball).
**Demo only: play money, sample fixtures, simulated odds. No real payments or real bets.**

## Run
Requires Node 22.13+ (zero npm dependencies; uses built-in `node:sqlite`).

```
npm start          # http://localhost:3000   (PORT, DB_PATH, DEMO_MODE=false, NODE_ENV=production are supported)
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
- `server/server.js` – JSON API + static hosting with a strict CSP.
- `public/` – the browser app (display only; no odds, balances or RNG in the browser).

## Features
- Sports menu, live events with simulated score/odds movement, 1X2 / winner / over-under markets
- Bet slip: singles and multiples, stake presets, potential return, one selection per match in multiples
- Real accounts (username + password), 18+ check, play-money deposits, daily deposit limit enforced on the server, wallet statement
- My Bets with simulated settlement (`/api/bets/settle-demo`, disabled when `DEMO_MODE=false`)
- Responsible-gambling footer and SARGF helpline (0800 006 008)
- Responsive (mobile bet-slip drawer)

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
