# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

ApexBets (repo: BreezyBets): a demo South African sportsbook plus six "Apex Games". **Play money only**: no real payments or bets. Plain Node, **zero npm dependencies**, ES modules, built-in `node:sqlite`. Requires Node >= 22.13. `README.md` has the feature list and env vars; `docs/` holds business, licence, payments and hosting material (much of the repo's history is business docs, not code).

## Commands

```
npm start                                   # http://localhost:3000 (env: PORT, DB_PATH, DEMO_MODE, GAMES_ENABLED, LIMIT_COOLOFF_HOURS, AUTO_APPROVE_MAX_CENTS, TRUST_PROXY)
npm test                                    # all node:test suites in test/*.test.js (~3s, no browser)
node --disable-warning=ExperimentalWarning --test test/safety.test.js          # one file
node --disable-warning=ExperimentalWarning --test --test-name-pattern="regex" test/*.test.js   # one test
npm run e2e                                 # Playwright browser run (test/e2e.cjs); Playwright is not a dependency, it must be installed separately
node tools/measure-data.cjs                 # bytes-on-the-wire measurement
node tools/cashback-model.mjs [players] [days] [keep]   # loss-rebate simulation
```

There is no build step and no linter configured. Keep it dependency-free: do not add npm packages.

## Architecture

- `server/server.js` exports `createApp({ dbPath, simulate, signupsPerHour, ... })`, which builds the JSON API and static hosting (strict CSP, gzip, lean odds routes). Tests call it with `dbPath: ':memory:'` and `simulate: false`, listen on port 0, and drive it with `fetch` and a small cookie-jar client. Follow that pattern for new API tests.
- **Server is the only authority.** The browser (`public/`, vanilla JS, display only) never holds odds, balances or RNG. `server/odds.js` sets prices; a bet placed on stale odds gets `409 odds_changed`.
- **Money is a double-entry ledger** (`server/wallet.js`, schema in `server/db.js`). Amounts are integer cents; every transaction's entries sum to zero; player accounts (`user:<id>`) cannot go below 0; SQLite triggers make the ledger append-only. Balances are always derived from the ledger, never stored. Any feature that moves money must post a ledger transaction with a `kind` (see the list in `db.js`) rather than touch a balance column.
- `server/safety.js`: deposit limits (lowering applies at once, raising waits `LIMIT_COOLOFF_HOURS`), breaks that pause deposits/bets/games and cannot be ended early, monthly statement, play-through rule (deposits must be bet once before withdrawal).
- `server/withdrawals.js`: bank account, auto-approval up to `AUTO_APPROVE_MAX_CENTS`, simulated bank. Its header comment states what a real payment provider replaces.
- `server/auth.js`: scrypt passwords, session tokens stored only as SHA-256 hashes, rate limiting, server-side 18+ check.
- `server/games.js`: CSPRNG outcomes with exact ~95% RTP, verified in `test/games.test.js`. Changing a payout table means the RTP test must still hold.
- Modes: `DEMO_MODE=false` disables `/api/bets/settle-demo` and switches the games off unless `GAMES_ENABLED=true`.

## Deployment

Fly.io (Johannesburg) via `Dockerfile` and `fly.toml`; the DB lives on a volume at `/data`. `.github/workflows/deploy.yml` runs `npm test` then deploys on pushes to `main` and `claude/sa-betting-website-tg7b1p`; the deploy step is skipped until the `FLY_API_TOKEN` secret exists. See `docs/hosting.md`. Note the Dockerfile copies only `package.json`, `server/` and `public/`, so anything the running app needs must live there.

## Conventions

- User-facing copy is **English only** (a recorded decision) and written plainly for South African players; currency is rand (R), shown from cents.
- Responsible-gambling features (limits, breaks, SARGF helpline 0800 006 008, footer) are core, not optional; don't weaken them when touching betting or deposit flows.
- Development branch for this session's work: `claude/claude-md-setup-awwk2l`.
