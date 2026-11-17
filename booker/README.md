# Meeting booker

The booking page at [book.seane.us](https://book.seane.us/),
built from [eganator/meeting-booker](https://github.com/eganator/meeting-booker)'s guide, with
the sign-in copied from sat-fordhamprep. It's one Cloudflare Worker in plain JavaScript, with D1 for
storage and Email Sending for codes and invitations.

| File | What it does |
|---|---|
| `src/index.js` | Routes, the emailed-code sign-in, open times, booking and cancelling |
| `src/access.js` | Allow-list checks. The list itself is the `ALLOW_EMAILS` secret, not in the repo |
| `src/slots.js` | Open times from `HOURS`, minus bookings and busy blocks |
| `src/ics.js` | Busy blocks from the calendar's private iCal feed (repeating events included) |
| `src/invite.js` | The `.ics` invitation and cancellation, with the meeting's Jitsi Meet link |
| `src/time.js` | Time zones and daylight saving, with no library |
| `wrangler.jsonc` | Bindings and settings: hours, slot length, lead time, horizon |

The pages use the site's own `../style.css`, bundled into the Worker, so they match the site.

## Run it locally

```sh
cd booker
npm install
cp .dev.vars.example .dev.vars   # then put the real allow list in .dev.vars (git ignores it)
npm run dev          # http://localhost:8787, local D1, no Cloudflare login
npm test             # unit tests (time zones, calendar feed, invitations, allow list)
npm run test:e2e     # sign in, book, race for a slot, cancel, against wrangler dev
```

Locally, mail isn't delivered. Wrangler prints each message in the terminal and saves the
attachments under `.wrangler/tmp/email/`, so the sign-in code is in the terminal output.

## Going live

The Worker runs in Mike Egan's Cloudflare account. Mike handles the Cloudflare side, and it's
done: seane.us is in the account with the GitHub Pages DNS records copied across (DNS only),
along with the `meeting-booker` D1 database, the Turnstile widget for `book.seane.us`, and a
deploy token limited to this Worker and seane.us. The database ID and Turnstile site key are in
`wrangler.jsonc`.

Nothing here runs wrangler against that account by hand. Deploys happen only from GitHub Actions
(`.github/workflows/deploy-booker.yml`), which migrates D1, deploys, and then copies three GitHub
repo secrets into the Worker as Worker secrets.

What Sean sets in this repo (Settings → Secrets and variables → Actions, or `gh`):

| Name | Kind | Value |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | secret | The deploy token from Mike |
| `TURNSTILE_SECRET` | secret | The Turnstile secret from Mike |
| `ALLOW_EMAILS` | secret | Who can book, comma-separated; `@domain` admits a whole domain |
| `CAL_ICS_URL` | secret | Google Calendar → Settings → my calendar → "Secret address in iCal format" |
| `CLOUDFLARE_ACCOUNT_ID` | variable | Mike's account ID |
| `BOOKER_DEPLOY` | variable | `true`, set last, once Mike says email sending is on; it turns deploys on |

`ALLOW_EMAILS`, `TURNSTILE_SECRET` and `CAL_ICS_URL` are GitHub repo secrets that Sean sets, not
Worker secrets that Mike sets with wrangler. Never put any of them in a file or a commit.

Before telling people about it: try an address that isn't on the list (it should get the same
page and no email), book from two browsers at once, and accept an invite on a phone to check the time.

## Changing who can book

The allow list is the `ALLOW_EMAILS` secret, so nobody's address is in this public repo. To
change it, set the repo secret again with the whole new list (`gh secret set ALLOW_EMAILS`) and
rerun the deploy workflow (`gh workflow run deploy-booker.yml`). Once deployed, anyone removed
is signed out on their next request.

## Admin

These run against Mike's account, so they're for Mike (or a token with D1 access), not for this repo.

```sh
# Block a network by hand for 7 days
npx wrangler d1 execute meeting-booker --remote --command "INSERT INTO denylist (subject, label, until, reason, created_at) VALUES ('ip:203.0.113.5', 'note', unixepoch()+604800, 'manual', unixepoch())"
# Upcoming bookings
npx wrangler d1 execute meeting-booker --remote --command "SELECT start_utc, email, note FROM booking WHERE cancelled=0 AND end_utc > strftime('%Y-%m-%dT%H:%M:%SZ','now') ORDER BY start_utc"
```
