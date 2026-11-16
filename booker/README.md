# Meeting booker

The booking page behind [seane.us/meetings](https://seane.us/meetings/),
built from [eganator/meeting-booker](https://github.com/eganator/meeting-booker)'s guide, with
the sign-in copied from sat-fordhamprep. It's one Cloudflare Worker in plain JavaScript, with D1 for
storage and Email Sending for codes and invitations.

| File | What it does |
|---|---|
| `src/index.js` | Routes, the emailed-code sign-in, open times, booking and cancelling |
| `src/access.js` | Allow-list checks. The list itself is the `ALLOW_EMAILS` secret, not in the repo |
| `src/slots.js` | Open times from `HOURS`, minus bookings and busy blocks |
| `src/ics.js` | Busy blocks from the calendar's private iCal feed (repeating events included) |
| `src/invite.js` | The `.ics` invitation and cancellation |
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

## Going live (Mike's side)

1. Move seane.us's nameservers to Mike's Cloudflare account.
   GitHub Pages keeps working: recreate its DNS records (the apex `A`/`AAAA` records and
   `www`) in Cloudflare, DNS only (grey cloud).
2. Onboard seane.us for Email Sending; create a Turnstile widget for `book.seane.us`.
3. In `wrangler.jsonc`, set `TURNSTILE_SITEKEY` and the `database_id` from
   `npx wrangler d1 create meeting-booker`.
   Check that rate-limit `namespace_id`s 5101-5104 aren't already used in the account.
4. Secrets: `npx wrangler secret put ALLOW_EMAILS` (comma-separated addresses),
   `npx wrangler secret put TURNSTILE_SECRET` and `npx wrangler secret put CAL_ICS_URL`
   (Google Calendar → Settings → my calendar → "Secret address in iCal format"). Never commit these.
5. In this repo: secret `CLOUDFLARE_API_TOKEN`, variables `CLOUDFLARE_ACCOUNT_ID` and
   `BOOKER_DEPLOY=true`. After that, every push to `main` that touches `booker/` tests and deploys.
6. On `meetings/index.html`, swap the "not live yet" note for the link (it's in a comment there).

Before telling people about it: try an address that isn't on the list (it should get the same
page and no email), book from two browsers at once, and accept an invite on a phone to check the time.

## Changing who can book

The allow list is the `ALLOW_EMAILS` secret, so nobody's address is in this public repo. To
change it: `npx wrangler secret put ALLOW_EMAILS` with the whole new list. It takes effect at
once, and anyone removed is signed out on their next request.

## Admin

```sh
# Block a network by hand for 7 days
npx wrangler d1 execute meeting-booker --remote --command "INSERT INTO denylist (subject, label, until, reason, created_at) VALUES ('ip:203.0.113.5', 'note', unixepoch()+604800, 'manual', unixepoch())"
# Upcoming bookings
npx wrangler d1 execute meeting-booker --remote --command "SELECT start_utc, email, note FROM booking WHERE cancelled=0 AND end_utc > strftime('%Y-%m-%dT%H:%M:%SZ','now') ORDER BY start_utc"
```
