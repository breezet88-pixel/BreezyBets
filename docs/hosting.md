# Hosting ApexBets

**Chosen host: Fly.io, Johannesburg region.** Everything needed is in this repository; three one-time steps on your side connect it to your own Fly account.

## Why Fly.io

| Need | Fly.io | Render | Railway |
|---|---|---|---|
| A region in South Africa | Yes (Johannesburg) | No | No |
| Keeps the database file between restarts | Yes (volume) | Paid plans only; free services cannot attach a disk | Yes |
| HTTPS with HTTP/2, automatic | Yes | Yes | Yes |
| Cost for a small site | About $2 a month for the machine plus about $0.15 per GB of disk, by usage | From about $7 a month with a disk | From about $5 a month |

Prices are from public pricing pages and review sites in November 2026 ([Fly](https://fly.io/pricing/), [Render](https://render.com/pricing.md)) and will change. Fly has no free tier, so it asks for a card. I could not confirm a Johannesburg-specific price; check the region selector on Fly's pricing page.

## What is already set up

- `Dockerfile`: the app in one small container. Tested: it builds, runs, and an account survives the container being replaced.
- `fly.toml`: Johannesburg, a 1 GB disk for the database at `/data`, HTTPS only, a health check, and sleep-when-idle so the bill stays small. The first visit after a quiet spell takes a second or two while it wakes.
- `.github/workflows/deploy.yml`: on every push, GitHub runs the tests and then deploys. Until the secret in step 3 exists it only runs the tests.
- The app itself: reads each visitor's real address from the host's proxy (`TRUST_PROXY=1`), so sign-up and login limits apply per visitor; cookies are HTTPS-only in production.

## Your three steps (all possible from a phone)

1. **Create a Fly.io account** at https://fly.io and add a payment card.
2. **Create an access token.** In the Fly dashboard open **Tokens**, create a token for your organisation, and copy it.
3. **Give the token to GitHub, not to anyone else.** In this repository on GitHub open **Settings**, then **Secrets and variables**, then **Actions**, choose **New repository secret**,
   and save it with the name `FLY_API_TOKEN`.
   Never paste the token into a chat, an email or a file.

Then push any change (or ask Claude to trigger a deploy). GitHub's **Actions** tab shows the run; when it is green the site is at **https://apexbets-za.fly.dev**.

### If the name is taken
Site names are unique across all of Fly. If `apexbets-za` is already someone else's, the deploy fails at "Create the app". On GitHub, under Settings, Secrets and variables, Actions, Variables, add a variable `FLY_APP` with another name, such as `apexbets-sa`. The address becomes `https://<that name>.fly.dev`.

## Things to know

- **This deploys the play-money demo.** `DEMO_MODE` is on. Real-money operation needs a licence, a certified platform and a payment provider (see `docs/competitive-analysis.md` and `docs/payments.md`).
- **Check Fly's acceptable-use policy before any real-money use.** I could not confirm what it says about gambling ([policy](https://fly.io/legal/acceptable-use-policy)). The national regulator has also published a notice on keeping data in South Africa; the Johannesburg region helps, but read the notice before going live.
- **Sample matches restart when the machine wakes.** They are generated at start-up, so open bets from before a restart can no longer be settled by the demo. Accounts, balances and history are kept.
- **Backups:** Fly takes daily snapshots of the disk and keeps them for a few days by default. For real use, add your own backups.
- **Your own domain:** once the site is up, a domain such as `apexbets.co.za` can be pointed at it from the Fly dashboard under Certificates.
- **One machine only.** The database is a single file, so the site must not be scaled to several machines. The workflow deploys with `--ha=false` for that reason.
