# ApexBucks

Personal income and spending app: Virgin Active class income (11th to 10th invoice periods), B-Active salary
worked out from a payslip (PAYE, UIF, loan), expenses, savings and a month-by-month forecast.
Play-money project files elsewhere in this repo are unrelated.

`index.html` is the whole app: plain HTML, CSS and JavaScript, no dependencies. It runs two ways from the same file.

## 1. Inside Claude (artifact)
Published as a Claude artifact. Data is kept in the artifact's database, so a phone and a laptop stay in step.
Quick add can use Claude to read a note.

## 2. Installable web app (PWA)
```
node breeze-money/build.mjs      # writes breeze-money/dist/
```
Upload the `dist` folder to any static HTTPS host (GitHub Pages, Netlify, Cloudflare Pages).
Open the site on a phone and choose Install app or Add to Home Screen. It then works offline.

- Data is saved on the device only (browser storage). Use Setup, Your data, Download full backup now and then.
- To move numbers across, download the full backup from the old version and use Restore from backup
  (the Welcome card on the first screen, or Setup, Your data).
- Quick add uses the built-in reader and the phone's speech recognition where the browser has it.
- Receipt scanning (photo to expenses split by type of spend) needs Claude, so it only works in the Claude version.
- The Refresh button at the bottom also checks for a newer version of the app.
- `brand/` holds the original logo and `icons/` holds the home-screen icons cut from it, unaltered.

Backups contain personal figures. Keep them out of the repo.
