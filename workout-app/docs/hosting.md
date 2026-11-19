# Putting FitLibrary online

Two small apps: the **API** (`backend/`) and the **website** (`frontend/`). The files below are set up for [Fly.io](https://fly.io) in Johannesburg, which needs a Fly account and card. Both Docker images have been built and run locally (including data surviving a container restart); the deploy to your own Fly account has not been run yet.

## Automatic deploys (recommended)

The repository has a GitHub Actions workflow (`.github/workflows/fitlibrary-deploy.yml`). On every push to this app's branch it runs all the tests, then deploys the API and the website to Fly.io. It creates the two apps and the data disk the first time, keeps the API on exactly **one** machine (the database is one file), and checks both are up. You only do this once:

1. **Fly.io account.** Sign up at fly.io and add a payment card (Fly needs one even for small apps).
2. **Fly token.** Create an **organisation** token: in the Fly dashboard under *Tokens*, or with `fly tokens create org` if you have flyctl installed. It must be an org token (not an app token) because the first run creates the apps. Copy it once; Fly will not show it again.
3. **GitHub secrets.** In GitHub open the repository → *Settings* → *Secrets and variables* → *Actions* → *New repository secret*, and add:

   | Secret | Value |
   |---|---|
   | `FLY_API_TOKEN` | the Fly token (if the betting app already uses this secret with the same Fly account, keep it) |
   | `FITLIBRARY_ADMIN_USERNAME` | your coach username |
   | `FITLIBRARY_ADMIN_PASSWORD` | your coach password (12+ characters strongly recommended) |
   | `FITLIBRARY_EMAIL_API_KEY`, `FITLIBRARY_EMAIL_FROM` | optional, for real emails (step 3 below) |

   Secrets are encrypted by GitHub, hidden in logs, and never stored in the code.
4. **Run it.** Open the *Actions* tab → *FitLibrary test and deploy* → the latest run → *Re-run all jobs*. (Any later push also deploys.) The first deploy takes a few minutes.
5. When it finishes, the run summary shows your **website**, **coach page** and **API** addresses, by default `https://fitlibrary-web.fly.dev` and `https://fitlibrary-api.fly.dev`.

If a run fails with *"Name has already been taken"*, someone else on Fly has that app name. Under *Settings* → *Secrets and variables* → *Actions* → *Variables*, set `FITLIBRARY_API_APP` and `FITLIBRARY_WEB_APP` to names of your own (e.g. `lindeni-fit-api`), then re-run. For your own domain later, also set `FITLIBRARY_WEB_URL` (and `FITLIBRARY_API_URL` if the API gets one).

Until the secrets exist, the workflow only runs the tests and leaves a notice saying what is missing.

## Deploying by hand instead

## 1. The API

```
cd backend
fly launch --no-deploy --copy-config      # accept the name in fly.toml, or pick another
fly volumes create fitlibrary_data --region jnb --size 1
fly secrets set \
  ADMIN_USERNAME='<your username>' \
  ADMIN_PASSWORD='<your password>' \
  CORS_ORIGINS='https://fitlibrary-web.fly.dev' \
  APP_URL='https://fitlibrary-web.fly.dev'
fly deploy
```

`CORS_ORIGINS` and `APP_URL` must be the address of the **website** (step 2), exactly, with no trailing slash. Secrets stay on Fly: they are never in the code.

## 2. The website

```
cd frontend
# make sure API_URL in fly.toml is your API's address, then:
fly launch --no-deploy --copy-config
fly deploy
```

Open the website address. Your coach page is the same address plus `/admin`.

## 3. Emails (verify address, forgot password)

The API sends these through [Resend](https://resend.com) (free tier is enough to start):

1. Create a Resend account, add and verify your domain (needs access to its DNS settings).
2. Create an API key, then:
   ```
   cd backend
   fly secrets set EMAIL_API_KEY='re_...' EMAIL_FROM='FitLibrary <noreply@yourdomain.co.za>'
   ```
3. With a key set, customers must confirm their email before posting or downloading. Without one, nobody can receive the link, so verification stays off and the "forgot password" email is only printed in the server log, which means **it does not work for real customers until you do this step.**

## 4. Your own address (optional)

`fly certs add www.yourdomain.co.za` on the website app, then point your DNS at it. Afterwards update `CORS_ORIGINS` and `APP_URL` on the API to the new address.

## Keep in mind

- **Admin password.** A short password such as 4 digits can be guessed. The server locks the coach account for 15 minutes after 5 wrong tries, which slows guessing a lot but does not make a 4-digit PIN safe, and it means someone could keep locking you out. Use 12+ characters for the live site.
- **Backups.** Everything you create is on the `/data` volume: `fly ssh sftp` or `fly volumes snapshots list` for snapshots.
- **One machine.** SQLite is a single file, so keep the API at one machine. That comfortably serves thousands of members.
- **Privacy notice (POPIA)** for the names and emails you collect.
