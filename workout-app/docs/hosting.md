# Putting FitLibrary online

Two small apps: the **API** (`backend/`) and the **website** (`frontend/`). The files below are set up for [Fly.io](https://fly.io) in Johannesburg, which needs a Fly account and card. I have not been able to deploy to your account from here, so treat these as a tested-locally starting point and expect to adjust names.

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
