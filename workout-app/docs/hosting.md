# Putting FitLibrary online (Vercel)

FitLibrary runs on **Vercel** as one project: the website and the API live at the same address.

| Part | Where it lives on Vercel |
|---|---|
| Website (member app + coach page) | Vercel's static hosting (`frontend/public`) |
| API | one Vercel Function (`api/handler.js`), the same code that runs locally |
| Exercise pictures | **Vercel Blob** |
| Database (workouts, accounts, reviews) | **Turso**, hosted SQLite from the Vercel Marketplace |

Vercel watches the GitHub repository and redeploys by itself on every push. GitHub Actions only runs the tests.

## Before you start: the free plan

Vercel's free **Hobby** plan is for [non-commercial, personal use only](https://vercel.com/docs/limits/fair-use-guidelines). The app is free, but if you switch on the **donation link**, Vercel may count the site as commercial. Their docs say to [contact Vercel Support](https://vercel.com/docs/plans/hobby) if unsure, or use the paid Pro plan. Ask them before you turn donations on. Turso and Blob both have free tiers that are plenty to start with.

## One-time setup (about 15 minutes)

Vercel's buttons get renamed from time to time. If a label below doesn't match exactly, look for the closest one.

1. **Vercel account.** Go to vercel.com → *Sign Up* → *Continue with GitHub*. Allow Vercel to see the **BreezyBets** repository.
2. **Import the project.** *Add New…* → *Project* → pick `breezet88-pixel/BreezyBets` → *Import*. Then:
   - **Root Directory**: click *Edit* and choose **`workout-app`**. This matters: the repository also holds the betting site.
   - **Framework Preset**: *Other*. Leave the build and output settings alone (they come from `workout-app/vercel.json`).
   - **Environment Variables**: add `ADMIN_USERNAME` (your coach username) and `ADMIN_PASSWORD` (your coach password).
   - Click **Deploy**. The site appears, but it shows "Hosting is not finished" until steps 3 and 4 are done.
3. **Pictures: Vercel Blob.** In the project, open the **Storage** tab → *Create* → **Blob** → create the store and **connect it to this project** (all environments). This adds `BLOB_READ_WRITE_TOKEN` for you.
4. **Database: Turso.** Still on **Storage**, choose **Turso Cloud** from the Marketplace → create a database → **connect it to this project**. This adds `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`.
5. **Which branch is live.** The repository's main branch is the betting site, so tell Vercel which branch holds this app: *Settings* → *Git* → **Production Branch** → `ccr-badd2cd7-yp33cp`. (Change this later if the app moves to its own branch or repository.)
6. **Redeploy.** New settings only reach new deployments: *Deployments* → the latest one → *⋯* → *Redeploy*.
7. **Check.** Open `https://<your-project>.vercel.app/api/health`. It should say `{"ok":true}`. If it lists `missing` settings, add those and redeploy. Then:
   - Members: `https://<your-project>.vercel.app`
   - You: `https://<your-project>.vercel.app/admin`

From then on, every push to the production branch goes live automatically.

## Optional

- **Real emails** (confirm address, forgot password): create a [Resend](https://resend.com) account, verify your domain, then add `EMAIL_API_KEY` and `EMAIL_FROM` (e.g. `FitLibrary <noreply@yourdomain.co.za>`) as Environment Variables and redeploy. Until then those emails go nowhere, and customers can't reset their own password.
- **Your own address**: *Settings* → *Domains*. If you use one, also set `APP_URL` to it (used in email links).
- **Speed for South African visitors**: by default Vercel runs the API in the US. If you pick a Turso location and a Vercel function region (*Settings* → *Functions*) close together and near your members, pages respond faster. Keep the two in the same region either way.

## Keep in mind

- **Admin password**: a short password can be guessed. The server locks the coach account for 15 minutes after 5 wrong tries (shared across all of Vercel's server copies), but 12+ characters is much safer.
- **Picture size**: uploads are limited to 4 MB each (Vercel's request limit is 4.5 MB). The downloadable workout embeds pictures up to about 3.5 MB in total and links the rest.
- **Backups**: Turso keeps point-in-time backups on its side; check what your plan includes. Pictures stay in your Blob store until you remove them from a workout.
- **Privacy notice (POPIA)** for the names and emails you collect.

## Running it elsewhere

The same code also runs as a normal Node server with a SQLite file and a pictures folder (no Turso or Blob needed): see the README for local use. `backend/Dockerfile`, `frontend/Dockerfile` and the `fly.toml` files still work for Docker or Fly.io hosting if you ever move.
