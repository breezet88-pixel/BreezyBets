# BreezyBets (demo)

A South African–style online sportsbook front end (PSL soccer, URC/Test rugby, SA20 cricket, tennis, basketball).
**Demo only: play money, sample fixtures, simulated odds. No real payments or real bets.**

## Run
Open `index.html` in a browser, or `python3 -m http.server` and visit http://localhost:8000.

## Features
- Sports menu, live events with simulated score/odds movement, 1X2 / winner / over-under markets
- Bet slip: singles and multiples, stake presets, potential return, one selection per match in multiples
- Demo registration with 18+ date-of-birth check, play-money deposits, daily deposit limit
- My Bets with simulated settlement; state saved in `localStorage`
- Responsible-gambling footer and SARGF helpline (0800 006 008)
- Responsive (mobile bet-slip drawer)

## Going to production: what a real site needs
1. **Licence**: operate only with a provincial gambling board bookmaker licence (National Gambling Act); geo-block/age-gate accordingly.
2. **FICA/KYC**: RSA ID verification, proof of address, sanctions/PEP checks, self-exclusion integration.
3. **Backend**: server-side bet acceptance, wallet ledger (double-entry), authentication (hashed passwords, 2FA), audit logs. Never trust client-side odds or balances (this demo does, deliberately).
4. **Odds & results**: licensed data feed (e.g. Sportradar, Betradar, Genius) plus a trading/risk engine.
5. **Payments**: PCI-compliant provider (EFT, cards, Ozow, vouchers), withdrawals, fraud checks.
6. **Compliance**: tax handling, responsible-gambling tools (limits, cool-off, reality checks), data protection (POPIA).
