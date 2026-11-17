/**
 * Sean Egan's meeting booker: one Worker, behind an emailed one-time code.
 *
 *   /              signed in -> /slots; otherwise the email form
 *   /auth/start    sends a 6-digit code if the address is on the allow list (src/access.js);
 *                  otherwise records a decoy and shows the same page, so the form never answers
 *                  "is this address allowed?"
 *   /verify        the code form
 *   /auth/verify   checks the code, sets a 7-day session cookie
 *   /slots         open times: HOURS, minus bookings, minus busy times from the calendar feed
 *   /book          confirm a time (GET), then book it (POST); both of you get an invitation
 *   /cancel        cancel your booking; both of you get a cancellation
 *   /logout        sign out
 *
 * The sign-in is sat-fordhamprep's (site/src/index.ts), cut down to email only:
 *   - A code works only in the browser that asked for it (a pre-sign-in cookie bound to the
 *     challenge), only once, for 10 minutes, for 5 tries. Tries and use are counted with single
 *     atomic UPDATEs, so parallel requests can't beat the limits.
 *   - Turnstile on the email form. A failed token takes the decoy path: nothing is sent.
 *   - At most 5 codes an hour per mailbox (+tags folded, decoys counted) and a site-wide daily
 *     send budget, both checked the same way for every address.
 *   - A site-wide circuit breaker pauses code entry for an hour after 30 wrong codes in 10
 *     minutes and tells the owner. More than 30 wrong codes in 24 hours for one mailbox
 *     deny-lists it for 7 days. A client can be deny-listed by hand (see README).
 *   - The allow list is checked again on every request, so removing someone works at once.
 *   - Codes, session ids and bindings are stored only as sha256.
 *   - Writes must come from this origin; responses forbid framing and caching; the only script
 *     on any page is Turnstile's.
 *
 * Who may book is the ALLOW_EMAILS secret (src/access.js), not anything in this repo.
 *
 * Bookings: one row each in D1. A unique index on the start time stops two people taking the
 * same slot; the insert also refuses a second upcoming booking for the same person. A time is
 * accepted only if it is one of the open slots right now, so no one can book outside HOURS.
 */

import { parseEmail, mailboxOf, mayBook } from "./access.js";
import { clientKey } from "./net.js";
import { esc, randomHex, sha256 } from "./http.js";
import { parseHours, openSlots } from "./slots.js";
import { busyFromIcs } from "./ics.js";
import { invite } from "./invite.js";
import { iso, parseIso, whenText, dayText, timeText } from "./time.js";
// The site's own stylesheet, bundled as text (wrangler.jsonc "rules"), so these pages look
// like the rest of seanpategan.github.io and there is only one copy of it.
import STYLE from "../../style.css";

const OTP_TTL = 10 * 60;
const OTP_MAX_ATTEMPTS = 5;
const CODES_PER_HOUR = 5;              // per mailbox (+tags folded), decoys included
const DAILY_SEND_BUDGET = 100;         // code emails a day, site-wide
const BREAKER_WRONG = 30;              // wrong codes site-wide within BREAKER_WINDOW trips the breaker
const BREAKER_WINDOW = 10 * 60;
const BREAKER_HOLD = 60 * 60;
const DENY_WRONG = 30;                 // wrong codes for one mailbox within DENY_WINDOW...
const DENY_WINDOW = 24 * 3600;
const DENY_FOR = 7 * 24 * 3600;        // ...deny-list it for this long
const SESSION_TTL = 7 * 24 * 3600;
const CAL_CACHE_MS = 5 * 60_000;       // how long a fetched calendar feed is reused
const NOTE_MAX = 500;
const SESSION_COOKIE = "__Host-mb_s";  // __Host-: Secure, Path=/, no Domain
const BIND_COOKIE = "__Host-mb_b";

// ------------------------------------------------------------------ helpers

const now = () => Math.floor(Date.now() / 1000);

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Uniform over 000000-999999: rejects the top sliver of the 32-bit range. */
function sixDigits() {
  const a = new Uint32Array(1);
  do crypto.getRandomValues(a); while (a[0] >= 4_294_000_000);
  return String(a[0] % 1_000_000).padStart(6, "0");
}

function cookie(req, name, hexLen) {
  const m = (req.headers.get("Cookie") ?? "").match(new RegExp(`(?:^|;\\s*)${name}=([a-f0-9]{${hexLen}})(?:;|$)`));
  return m ? m[1] : null;
}

const setCookie = (name, value, maxAge) =>
  `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

const clientIp = (req) => req.headers.get("CF-Connecting-IP") ?? "unknown";
const limitKey = (req) => clientKey(clientIp(req));
const where = (req) => [req.cf?.city, req.cf?.region, req.cf?.country].filter(Boolean).join(", ");

const settings = (env) => ({
  tz: env.TZ || "America/New_York",
  hours: parseHours(env.HOURS),
  slotMin: Number(env.SLOT_MINUTES) || 30,
  leadH: Number(env.LEAD_HOURS) || 0,
  horizonD: Number(env.HORIZON_DAYS) || 21,
});

/** The audit trail. Never fails the request. */
async function log(env, req, kind, f = {}) {
  try {
    await env.DB.prepare("INSERT INTO event (at, kind, email, mb_hash, detail, ip, ip_key, country, ua) VALUES (?,?,?,?,?,?,?,?,?)")
      .bind(new Date().toISOString(), kind, f.email ?? null, f.mb ?? null, f.detail ?? null, clientIp(req), limitKey(req),
        req.cf?.country ?? null, (req.headers.get("User-Agent") ?? "").slice(0, 300)).run();
  } catch (e) {
    console.error("audit log failed", kind, e instanceof Error ? e.message : String(e));
  }
}

/**
 * log(), for refusals anyone can trigger at will (rate limited, malformed input): once an hour
 * per kind and client from each isolate, so a flood can't fill D1.
 */
const throttled = new Map();
async function logThrottled(env, req, kind, f = {}) {
  const k = `${kind} ${limitKey(req)}`;
  if (Date.now() - (throttled.get(k) ?? 0) < 3600_000) return;
  if (throttled.size >= 5000) throttled.delete(throttled.keys().next().value);
  throttled.set(k, Date.now());
  await log(env, req, kind, f);
}

async function sendMail(env, msg) {
  // BCC_EMAIL (optional var): a blind copy of every email the Worker sends, sign-in codes included.
  const bcc = env.BCC_EMAIL && env.BCC_EMAIL !== msg.to ? { bcc: env.BCC_EMAIL } : {};
  try {
    await env.EMAIL.send({ from: { email: env.FROM_ADDRESS, name: `${env.OWNER_NAME} (meetings)` }, ...bcc, ...msg });
    return true;
  } catch (e) {
    console.error("email failed", msg.to, e instanceof Error ? e.message : String(e));
    return false;
  }
}

// ------------------------------------------------------------------ pages

const ROBOTS_TXT = "# Private booking page. Please don't crawl it.\nUser-agent: *\nDisallow: /\n";

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; script-src https://challenges.cloudflare.com; style-src 'self'; img-src 'self' data:; " +
    "frame-src https://challenges.cloudflare.com; connect-src https://challenges.cloudflare.com; " +
    "form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  // same-origin, not no-referrer: under no-referrer browsers send "Origin: null" on our own
  // form posts, which the same-origin POST check (rightly) refuses.
  "Referrer-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Cache-Control": "private, no-store",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
};

function withSecurity(r) {
  const h = new Headers(r.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) h.set(k, v);
  if (h.get("Content-Type")?.startsWith("text/css")) h.set("Cache-Control", "public, max-age=3600");
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
}

const FAVICON = "data:image/svg+xml,&lt;svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22&gt;" +
  "&lt;text x=%2250%22 y=%22.72em%22 font-size=%2290%22 fill=%22white%22 text-anchor=%22middle%22&gt;~&lt;/text&gt;&lt;/svg&gt;";

/** A page in the same frame as every page on seanpategan.github.io. `who`: the signed-in address, for the footer. */
function page(env, title, body, { status = 200, headers = {}, who = null } = {}) {
  const site = env.SITE_URL.replace(/\/$/, "");
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta name="color-scheme" content="light dark">
	<meta name="robots" content="noindex, nofollow">
	<link rel="stylesheet" type="text/css" href="/style.css">
	<link rel="icon" href="${FAVICON}">
	<title>${esc(title)} - ${esc(env.OWNER_NAME)}</title>
</head>
<body>
	<header>${esc(env.OWNER_NAME)}</header>
	<nav>
		<a href="${site}/">Home</a>
		<a href="${site}/projects/">Projects</a>
		<a href="${site}/tech/">Tech</a>
		<a href="/">Meetings</a>
	</nav>
	<hr>
	<main>
	<article>
${body}
</article>
	</main>
	<hr>
	<footer>
		<small>
			<center>
				${who ? `Signed in as ${esc(who)} &middot; <form class="inline" method="post" action="/logout"><button class="link" type="submit">Sign out</button></form> &middot; ` : ""}<a href="/privacy">Privacy</a>
			</center>
		</small>
	</footer>
</body>
</html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", ...headers } });
}

function redirect(to, cookies = []) {
  const h = new Headers({ Location: to });
  for (const c of cookies) h.append("Set-Cookie", c);
  return new Response(null, { status: 303, headers: h });
}

const errBox = (err) => (err ? `<div class="note err"><p>${esc(err)}</p></div>` : "");
const notFound = (env) => page(env, "Not found", "<h1>Not found</h1><p>There is nothing at this address.</p>", { status: 404 });
const forbidden = (env) => page(env, "Not allowed", "<h1>Not allowed</h1><p>This request was refused.</p>", { status: 403 });
const tooMany = (env) => page(env, "Slow down", "<h1>Too many requests</h1><p>Please wait a minute and try again.</p>",
  { status: 429, headers: { "Retry-After": "60" } });

const PRIVACY = (env) => `<h1>Privacy</h1>
<p>This page is only for people I've invited. To sign in you type your email address; if it's on my list you get a one-time code by email.</p>
<p>What's stored: your email address, the times you book and any note you add, and a log of sign-in attempts (time, IP address, browser) kept for security. Sign-in codes and session cookies are stored only in scrambled (hashed) form. Nothing is sold. The only emails sent are your sign-in codes and calendar invitations, and a copy of each goes to Mike Egan, who helps me run this site.</p>
<p>The site runs on Cloudflare. The sign-in form uses Cloudflare Turnstile to keep bots out.</p>
<p>To have your data deleted, email <a href="mailto:${esc(env.OWNER_EMAIL)}">${esc(env.OWNER_EMAIL)}</a>.</p>`;

function signInPage(env, err = "", status = 200) {
  return page(env, "Book a meeting", `<h1>Book a meeting</h1>
${errBox(err)}<p>Enter your email address and I'll send you a 6-digit code. Once you're in, this browser stays signed in for 7 days.</p>
<form method="post" action="/auth/start">
	<label for="em">Email address</label>
	<input id="em" type="email" name="email" required autocomplete="email" autofocus maxlength="254">
	<div class="cf-turnstile" data-sitekey="${esc(env.TURNSTILE_SITEKEY)}" data-action="signin"></div>
	<button type="submit">Send me a code</button>
</form>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
<p class="date">Booking is invite only. If you'd like to meet and aren't on the list, <a href="mailto:${esc(env.OWNER_EMAIL)}">email me</a>. See <a href="/privacy">what this page stores</a>.</p>`, { status });
}

function verifyPage(env, challenge, err = "", status = 200) {
  return page(env, "Enter your code", `<h1>Check your email</h1>
${errBox(err)}<p>If that address is on my list, a 6-digit code is on its way. It expires in 10 minutes. If it hasn't arrived in a minute or two, check your junk folder.</p>
<form method="post" action="/auth/verify">
	<input type="hidden" name="c" value="${esc(challenge)}">
	<label for="cd">6-digit code</label>
	<input id="cd" class="code" type="text" name="code" required autofocus inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}">
	<button type="submit">Continue</button>
</form>
<p>Wrong address? <a href="/">Start again</a>.</p>`, { status });
}

const expiredPage = (env) => page(env, "Expired", `<h1>That code has expired</h1>
<p>Codes last 10 minutes and allow 5 tries. <a href="/">Start again</a> for a new one.</p>`, { status: 400 });

// ------------------------------------------------------------------ sessions

/** The signed-in address, or null. A session for an address no longer on the list is no session. */
async function signedIn(env, req) {
  const sid = cookie(req, SESSION_COOKIE, 64);
  if (!sid) return null;
  const row = await env.DB.prepare("SELECT email FROM session WHERE id_hash=? AND expires_at>?")
    .bind(await sha256(sid), now()).first();
  const email = row ? parseEmail(row.email) : null;
  if (!email || !mayBook(email, env)) return null;
  if (await isDenied(env, mbSubject(await sha256(mailboxOf(email))))) return null;
  return email;
}

// ------------------------------------------------------------------ sign-in

async function postStart(env, req, ctx) {
  if (!(await env.RL_START_IP.limit({ key: limitKey(req) })).success) {
    ctx.waitUntil(logThrottled(env, req, "start_ratelimited", { detail: "client" }));
    return tooMany(env);
  }
  const f = await req.formData();
  // Turnstile first. A failed or missing token isn't refused: it takes the decoy path, so the
  // form still says nothing about which addresses are allowed, and nothing is sent for it.
  const human = await turnstileOk(env, req, f.get("cf-turnstile-response"));
  const typed = String(f.get("email") ?? "").trim().slice(0, 300);
  if (!(await env.RL_START.limit({ key: `em:${(await sha256(typed.toLowerCase())).slice(0, 32)}` })).success) {
    ctx.waitUntil(logThrottled(env, req, "start_ratelimited", { email: parseEmail(typed), detail: "address" }));
    return tooMany(env);
  }

  const email = parseEmail(typed);
  if (!email) {
    ctx.waitUntil(logThrottled(env, req, "start_bad_input"));
    return signInPage(env, "That doesn't look like an email address.", 400);
  }

  // Site-wide budget, checked for every address alike so it reveals nothing about any one.
  const sent = await env.DB.prepare("SELECT COUNT(*) AS n FROM event WHERE kind='code_sent' AND at>?")
    .bind(new Date(Date.now() - 86400_000).toISOString()).first();
  const hash = await sha256(mailboxOf(email));
  if ((sent?.n ?? 0) >= DAILY_SEND_BUDGET) {
    await log(env, req, "budget_exhausted", { email, mb: hash });
    return signInPage(env, "Sign-in is temporarily unavailable. Please try again later.", 503);
  }
  if (await isDenied(env, mbSubject(hash))) {
    await log(env, req, "code_blocked", { email, mb: hash });
    return signInPage(env, "This address is blocked for now after too many incorrect codes. If it's yours, please try again in a week.", 403);
  }

  const allowed = human && mayBook(email, env);
  const code = allowed ? sixDigits() : null;
  const challenge = randomHex(24);
  const binding = randomHex(32);
  const t = now();

  // Insert only if this mailbox is under its hourly cap, in one statement, so parallel requests
  // can't all pass a separate count. Decoys count too.
  const ins = await env.DB.prepare(
    "INSERT INTO otp (challenge, email, email_hash, code_hash, binding_hash, created_at, expires_at) " +
    "SELECT ?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM otp WHERE email_hash=? AND created_at>?) < ?")
    .bind(challenge, allowed ? email : null, hash, code ? await sha256(`${challenge}:${code}`) : null,
      await sha256(binding), t, t + OTP_TTL, hash, t - 3600, CODES_PER_HOUR).run();
  if (!ins.meta.changes) {
    await log(env, req, "code_capped", { email, mb: hash });
    return signInPage(env, "Too many codes have been requested for this address. Please try again in an hour.", 429);
  }

  if (allowed) {
    await log(env, req, "code_sent", { email, mb: hash });
    // Sent after the response, so the allowed and decoy paths take the same time.
    ctx.waitUntil(sendCode(env, email, code, where(req)));
  } else {
    // Decoy: same pages, nothing sent. It fails only at code entry, where it looks like a typo.
    await log(env, req, human ? "code_decoy" : "turnstile_fail", { email, mb: hash });
  }
  return redirect(`/verify?c=${challenge}`, [setCookie(BIND_COOKIE, binding, OTP_TTL)]);
}

/**
 * Cloudflare Turnstile siteverify: true only for a fresh token solved on one of
 * TURNSTILE_HOSTNAMES for the "signin" action. Fails closed. Cloudflare's published testing
 * secrets return no action and hostname "example.com"; only the dev server's hostname list
 * contains example.com.
 */
async function turnstileOk(env, req, token) {
  if (typeof token !== "string" || token.length === 0 || token.length > 2048 || !env.TURNSTILE_SECRET) return false;
  const hostnames = new Set((env.TURNSTILE_HOSTNAMES ?? "").split(",").map((h) => h.trim()).filter(Boolean));
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, remoteip: clientIp(req) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return false;
    const v = await r.json();
    const actionOk = v.action === "signin" || (v.metadata?.result_with_testing_key === true && v.action === undefined);
    return v.success === true && actionOk && typeof v.hostname === "string" && hostnames.has(v.hostname);
  } catch (e) {
    console.error("siteverify failed", e instanceof Error ? e.message : String(e));
    return false;
  }
}

function sendCode(env, email, code, from) {
  const origin = from ? ` It was requested from near ${from}.` : "";
  return sendMail(env, {
    to: email,
    subject: `${code} is your sign-in code for booking a meeting with ${env.OWNER_NAME}`,
    text: `Your sign-in code is ${code}\n\n` +
      `It expires in 10 minutes and works only in the browser where you asked for it.${origin}\n\n` +
      `Never share this code. If you didn't ask for it, you can ignore this email.\n`,
    html: `<p>Your sign-in code is <strong style="font-size:1.4em;letter-spacing:.15em">${code}</strong></p>` +
      `<p>It expires in 10 minutes and works only in the browser where you asked for it.${esc(origin)}</p>` +
      `<p>Never share this code. If you didn't ask for it, you can ignore this email.</p>`,
  });
}

async function postVerify(env, req, ctx) {
  if (!(await env.RL_VERIFY.limit({ key: limitKey(req) })).success) {
    ctx.waitUntil(logThrottled(env, req, "verify_ratelimited"));
    return tooMany(env);
  }
  if (await breakerOpen(env, req)) {
    ctx.waitUntil(logThrottled(env, req, "verify_paused"));
    return page(env, "Paused", "<h1>Sign-in is paused</h1><p>Too many incorrect codes have been entered here, so code " +
      "entry is paused for up to an hour. Please try again later.</p>", { status: 503, headers: { "Retry-After": "3600" } });
  }

  const f = await req.formData();
  const challenge = String(f.get("c") ?? "").trim();
  const code = String(f.get("code") ?? "").trim();
  if (!/^[a-f0-9]{48}$/.test(challenge)) return expiredPage(env);

  // One atomic step: count the try, and only if the challenge is still live and under the limit.
  const row = await env.DB.prepare(
    "UPDATE otp SET attempts=attempts+1 WHERE challenge=? AND consumed=0 AND expires_at>? AND attempts<? " +
    "RETURNING email, email_hash, code_hash, binding_hash, attempts")
    .bind(challenge, now(), OTP_MAX_ATTEMPTS).first();
  if (!row) {
    await log(env, req, "code_expired");
    return expiredPage(env);
  }

  const binding = cookie(req, BIND_COOKIE, 64);
  if (!binding || !timingSafeEqual(row.binding_hash, await sha256(binding))) {
    await env.DB.prepare("UPDATE otp SET consumed=1 WHERE challenge=?").bind(challenge).run();
    await log(env, req, "binding_mismatch", { email: row.email, mb: row.email_hash });
    ctx.waitUntil(maybeDeny(env, req, row.email, row.email_hash));
    return page(env, "Start again", `<h1>Please start again</h1><p>A code only works in the browser where it was requested. ` +
      `<a href="/">Start again</a> in this browser.</p>`, { status: 400 });
  }

  const right = row.code_hash !== null && /^[0-9]{6}$/.test(code) &&
    timingSafeEqual(row.code_hash, await sha256(`${challenge}:${code}`));
  if (!right) {
    await log(env, req, "code_wrong", { email: row.email, mb: row.email_hash });
    await maybeDeny(env, req, row.email, row.email_hash);
    const left = OTP_MAX_ATTEMPTS - row.attempts;
    if (left <= 0) return expiredPage(env);
    return verifyPage(env, challenge, `That code was not correct. ${left} ${left === 1 ? "try" : "tries"} left.`, 400);
  }

  if (await isDenied(env, mbSubject(row.email_hash))) {
    await env.DB.prepare("UPDATE otp SET consumed=1 WHERE challenge=?").bind(challenge).run();
    await log(env, req, "code_blocked", { email: row.email, mb: row.email_hash });
    return page(env, "Blocked", "<h1>This address is blocked for now</h1><p>Too many incorrect codes have been " +
      "entered for it. If it's yours, please try again in a week.</p>", { status: 403 });
  }

  // Single use, even against two correct submissions racing each other.
  const used = await env.DB.prepare("UPDATE otp SET consumed=1 WHERE challenge=? AND consumed=0").bind(challenge).run();
  const email = parseEmail(row.email);
  if (!used.meta.changes || !email || !mayBook(email, env)) return expiredPage(env);

  const sid = randomHex(32);
  const t = now();
  await env.DB.prepare("INSERT INTO session (id_hash, email, created_at, expires_at) VALUES (?,?,?,?)")
    .bind(await sha256(sid), email, t, t + SESSION_TTL).run();
  await log(env, req, "signin", { email });
  ctx.waitUntil(sweep(env));
  return redirect("/slots", [setCookie(SESSION_COOKIE, sid, SESSION_TTL), setCookie(BIND_COOKIE, "", 0)]);
}

/** Drop dead challenges and sessions after each sign-in (the audit trail is kept). */
async function sweep(env) {
  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM otp WHERE expires_at<?").bind(now() - 86400),
      env.DB.prepare("DELETE FROM session WHERE expires_at<?").bind(now()),
    ]);
  } catch (e) {
    console.error("sweep failed", e instanceof Error ? e.message : String(e));
  }
}

/**
 * Circuit breaker: BREAKER_WRONG wrong codes site-wide within BREAKER_WINDOW pause code entry
 * for everyone for BREAKER_HOLD, and the owner hears about it (at most hourly).
 */
async function breakerOpen(env, req) {
  const tripped = await env.DB.prepare("SELECT 1 FROM event WHERE kind='breaker' AND at>? LIMIT 1")
    .bind(new Date(Date.now() - BREAKER_HOLD * 1000).toISOString()).first();
  if (tripped) return true;
  const wrong = await env.DB.prepare("SELECT COUNT(*) AS n FROM event WHERE kind IN ('code_wrong','binding_mismatch') AND at>?")
    .bind(new Date(Date.now() - BREAKER_WINDOW * 1000).toISOString()).first();
  const n = wrong?.n ?? 0;
  if (n < BREAKER_WRONG) return false;
  await log(env, req, "breaker");
  await sendMail(env, {
    to: env.OWNER_EMAIL,
    subject: "Meetings: code entry paused after repeated wrong codes",
    text: `${n} wrong codes were entered on ${env.HOSTS} in the last ${BREAKER_WINDOW / 60} minutes, so code entry is ` +
      `paused for ${BREAKER_HOLD / 60} minutes. This may be someone guessing codes.\n\n` +
      "Look at the event table: kind in ('code_wrong','binding_mismatch'), with ip and country.\n",
  });
  return true;
}

const mbSubject = (mailboxHash) => `mb:${mailboxHash}`;

async function isDenied(env, subject) {
  return !!(await env.DB.prepare("SELECT 1 FROM denylist WHERE subject=? AND until>?").bind(subject, now()).first());
}

/** If this mailbox now has more than DENY_WRONG wrong codes in DENY_WINDOW, deny-list it and tell the owner once. */
async function maybeDeny(env, req, email, mailboxHash) {
  const n = (await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM event WHERE mb_hash=? AND kind IN ('code_wrong','binding_mismatch') AND at>?")
    .bind(mailboxHash, new Date(Date.now() - DENY_WINDOW * 1000).toISOString()).first())?.n ?? 0;
  if (n <= DENY_WRONG) return;
  const subject = mbSubject(mailboxHash);
  const label = email ?? "an address not on the list";
  const t = now();
  const ins = await env.DB.prepare(
    "INSERT INTO denylist (subject, label, until, reason, created_at) VALUES (?,?,?,?,?) " +
    "ON CONFLICT(subject) DO UPDATE SET label=excluded.label, until=excluded.until, reason=excluded.reason, " +
    "created_at=excluded.created_at WHERE denylist.until<=?")
    .bind(subject, label, t + DENY_FOR, `${n} wrong codes in 24 hours`, t, t).run();
  if (!ins.meta.changes) return;
  await log(env, req, "denylisted", { mb: mailboxHash });
  await sendMail(env, {
    to: env.OWNER_EMAIL,
    subject: `Meetings: deny-listed ${label}`,
    text: `${n} wrong codes were entered for ${label} in 24 hours, so it gets no codes and is signed out for ` +
      `${DENY_FOR / 86400} days.\n\nTo lift it early: npx wrangler d1 execute meeting-booker --remote --command ` +
      `"DELETE FROM denylist WHERE subject='${subject}'"\n`,
  });
}

async function postLogout(env, req) {
  const sid = cookie(req, SESSION_COOKIE, 64);
  if (sid) {
    const row = await env.DB.prepare("DELETE FROM session WHERE id_hash=? RETURNING email").bind(await sha256(sid)).first();
    if (row) await log(env, req, "signout", { email: row.email });
  }
  return page(env, "Signed out", `<h1>Signed out</h1><p><a href="/">Sign in again</a></p>`,
    { headers: { "Set-Cookie": setCookie(SESSION_COOKIE, "", 0) } });
}

// ------------------------------------------------------------------ open times

let calCache = null;   // { url, at, text }

/** The calendar feed's text, cached for CAL_CACHE_MS. Throws if it can't be read. */
async function calendarText(env) {
  if (calCache && calCache.url === env.CAL_ICS_URL && Date.now() - calCache.at < CAL_CACHE_MS) return calCache.text;
  const r = await fetch(env.CAL_ICS_URL, { signal: AbortSignal.timeout(10_000), headers: { Accept: "text/calendar" } });
  if (!r.ok) throw new Error(`calendar feed answered ${r.status}`);
  const text = await r.text();
  if (!text.includes("BEGIN:VCALENDAR")) throw new Error("calendar feed is not iCal");
  calCache = { url: env.CAL_ICS_URL, at: Date.now(), text };
  return text;
}

/**
 * The open slots right now, or null if the calendar can't be checked: then nothing is offered,
 * rather than times that may clash. With no CAL_ICS_URL set (local dev), the calendar is skipped.
 */
async function currentSlots(env) {
  const s = settings(env);
  const t = Date.now();
  const to = t + (s.horizonD + 1) * 86400_000;
  const { results } = await env.DB.prepare("SELECT start_utc FROM booking WHERE cancelled=0 AND start_utc>=?")
    .bind(iso(t - 86400_000)).all();
  const booked = new Set(results.map((r) => Date.parse(r.start_utc)));
  let busy = [];
  if (env.CAL_ICS_URL) {
    try {
      busy = busyFromIcs(await calendarText(env), s.tz, t, to);
    } catch (e) {
      console.error("calendar unavailable", e instanceof Error ? e.message : String(e));
      return null;
    }
  }
  return openSlots({ now: t, ...s, booked, busy });
}

/** The signed-in person's upcoming booking, if any. */
const upcoming = (env, email) =>
  env.DB.prepare("SELECT id, start_utc, end_utc, note FROM booking WHERE email=? AND cancelled=0 AND end_utc>? ORDER BY start_utc LIMIT 1")
    .bind(email, iso(Date.now())).first();

async function slotsPage(env, email, err = "", status = 200) {
  const { tz } = settings(env);
  const mine = await upcoming(env, email);
  if (mine) {
    return page(env, "Your meeting", `<h1>Your meeting</h1>
${errBox(err)}<p>You're booked for <strong>${esc(whenText(Date.parse(mine.start_utc), tz))}</strong>. The calendar invitation is in your email.</p>
${meetUrl(env, mine) ? `<p>Join in your browser: <a href="${esc(meetUrl(env, mine))}">${esc(meetUrl(env, mine))}</a></p>\n` : ""}${mine.note ? `<p>Your note: ${esc(mine.note)}</p>` : ""}<p>You can have one upcoming meeting at a time. To pick a different time, cancel this one first.</p>
<form method="post" action="/cancel">
	<input type="hidden" name="id" value="${esc(mine.id)}">
	<button type="submit">Cancel this meeting</button>
</form>`, { status, who: email });
  }

  const slots = await currentSlots(env);
  if (!slots) {
    return page(env, "Open times", `<h1>Open times</h1>
<p>I can't check my calendar right now, so I'm not showing any times. Please try again in a few minutes.</p>`, { status: 503, who: email });
  }
  // One row per day, in the site's table style.
  const days = new Map();
  for (const sl of slots) {
    const d = dayText(sl.start, tz);
    if (!days.has(d)) days.set(d, []);
    days.get(d).push(sl);
  }
  const rows = [...days].map(([d, list]) =>
    `<tr><th>${esc(d)}</th><td>${list.map((sl) => `<a href="/book?start=${iso(sl.start)}">${esc(timeText(sl.start, tz))}</a>`).join(" &middot; ")}</td></tr>`).join("\n");
  const { slotMin } = settings(env);
  const zone = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "long" }).formatToParts(new Date())
    .find((p) => p.type === "timeZoneName")?.value ?? tz;
  return page(env, "Open times", `<h1>Open times</h1>
${errBox(err)}<p>Pick a time for a ${slotMin}-minute meeting. Times are ${esc(zone)}.</p>
${slots.length
    ? `<table class="times">\n${rows}\n</table>`
    : "<p>There are no open times right now. Check back later, or <a href=\"mailto:" + esc(env.OWNER_EMAIL) + "\">email me</a>.</p>"}`,
  { status, who: email });
}

async function confirmPage(env, email, startMs) {
  const { tz } = settings(env);
  const slots = await currentSlots(env);
  const slot = slots?.find((s) => s.start === startMs);
  if (!slot) return slotsPage(env, email, "That time isn't open any more. Please pick another.", 409);
  return page(env, "Confirm", `<h1>Confirm your meeting</h1>
<p><strong>${esc(whenText(slot.start, tz))}</strong>, for ${Math.round((slot.end - slot.start) / 60_000)} minutes.</p>
<form method="post" action="/book">
	<input type="hidden" name="start" value="${iso(slot.start)}">
	<label for="nt">What's it about? (optional)</label>
	<textarea id="nt" name="note" rows="3" maxlength="${NOTE_MAX}"></textarea>
	<button type="submit">Book it</button>
</form>
<p><a href="/slots">Back to open times</a></p>`, { who: email });
}

// ------------------------------------------------------------------ booking

/**
 * The video call for a booking: a Jitsi Meet room on MEETING_HOST, named from the booking's
 * random ID, so every meeting gets its own room that can't be guessed. Opens in the browser.
 */
function meetUrl(env, b) {
  const host = String(env.MEETING_HOST ?? "").trim().toLowerCase();
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? `https://${host}/seane-${b.id}` : "";
}

async function sendInvites(env, b, cancel) {
  const { tz } = settings(env);
  const when = whenText(b.start, tz);
  const ics = invite(b, { host: env.HOSTS.split(",")[0].trim(), ownerName: env.OWNER_NAME, ownerEmail: env.OWNER_EMAIL,
    fromAddress: env.FROM_ADDRESS, meetUrl: meetUrl(env, b), cancel });
  // One email each; just one when the owner books with himself.
  for (const to of new Set([b.email, env.OWNER_EMAIL])) {
    const owner = to === env.OWNER_EMAIL;
    await sendMail(env, {
      to,
      replyTo: owner ? b.email : env.OWNER_EMAIL,
      subject: `${cancel ? "Cancelled" : "Booked"}: ${when}${owner ? ` with ${b.email}` : ` with ${env.OWNER_NAME}`}`,
      text: (cancel
        ? `The meeting on ${when} is cancelled.`
        : `${owner ? `${b.email} booked` : "You're booked for"} ${when}. The calendar invitation is attached.` +
          (meetUrl(env, b) ? `\n\nJoin in your browser: ${meetUrl(env, b)}` : "")) +
        (b.note && !cancel ? `\n\nNote: ${b.note}` : "") + "\n",
      attachments: [{ disposition: "attachment", filename: "invite.ics",
        type: `text/calendar; method=${cancel ? "CANCEL" : "REQUEST"}`, content: ics }],
    });
  }
}

async function postBook(env, req, ctx, email) {
  const f = await req.formData();
  const start = parseIso(f.get("start"));
  const note = String(f.get("note") ?? "").replace(/\r\n?/g, "\n").trim().slice(0, NOTE_MAX);
  if (start === null) return slotsPage(env, email, "That time isn't open any more. Please pick another.", 400);
  // Only a time that is open right now: inside HOURS, in the window, not busy, not booked.
  const slots = await currentSlots(env);
  if (!slots) return slotsPage(env, email, "", 503);
  const slot = slots.find((s) => s.start === start);
  if (!slot) return slotsPage(env, email, "That time isn't open any more. Please pick another.", 409);

  const b = { id: randomHex(16), start: slot.start, end: slot.end, email, note };
  let ins;
  try {
    // One upcoming booking per person, checked in the same statement as the insert.
    ins = await env.DB.prepare(
      "INSERT INTO booking (id, start_utc, end_utc, email, note, created_at) SELECT ?,?,?,?,?,? " +
      "WHERE NOT EXISTS (SELECT 1 FROM booking WHERE email=? AND cancelled=0 AND end_utc>?)")
      .bind(b.id, iso(b.start), iso(b.end), email, note || null, new Date().toISOString(), email, iso(Date.now())).run();
  } catch (e) {
    // The unique index on live start times: someone took it a moment ago.
    if (/UNIQUE/i.test(e instanceof Error ? e.message : String(e))) {
      await log(env, req, "book_taken", { email, detail: iso(b.start) });
      return slotsPage(env, email, "Someone just took that time. Please pick another.", 409);
    }
    throw e;
  }
  if (!ins.meta.changes) return slotsPage(env, email, "You already have a meeting booked.", 409);
  await log(env, req, "booked", { email, detail: iso(b.start) });
  ctx.waitUntil(sendInvites(env, b, false));
  return redirect("/slots");
}

async function postCancel(env, req, ctx, email) {
  const f = await req.formData();
  const id = String(f.get("id") ?? "");
  if (!/^[a-f0-9]{32}$/.test(id)) return slotsPage(env, email, "", 400);
  const row = await env.DB.prepare(
    "UPDATE booking SET cancelled=1 WHERE id=? AND email=? AND cancelled=0 RETURNING start_utc, end_utc, note")
    .bind(id, email).first();
  if (row) {
    await log(env, req, "cancelled", { email, detail: row.start_utc });
    ctx.waitUntil(sendInvites(env, { id, start: Date.parse(row.start_utc), end: Date.parse(row.end_utc), email, note: row.note }, true));
  }
  return redirect("/slots");
}

// ------------------------------------------------------------------ routing

async function route(req, env, url, ctx) {
  const p = url.pathname;
  const method = req.method === "HEAD" ? "GET" : req.method;

  if (method === "POST") {
    // Same-origin POSTs only: a page elsewhere can't submit these forms (CSRF, login forcing).
    if (req.headers.get("Origin") !== url.origin) return forbidden(env);
    const ct = req.headers.get("Content-Type") ?? "";
    if (!ct.startsWith("application/x-www-form-urlencoded") && !ct.startsWith("multipart/form-data")) return forbidden(env);
    if (p === "/auth/start") return postStart(env, req, ctx);
    if (p === "/auth/verify") return postVerify(env, req, ctx);
    if (p === "/logout") return postLogout(env, req);
    const who = await signedIn(env, req);
    if (!who) return redirect("/");
    if (p === "/book") return postBook(env, req, ctx, who);
    if (p === "/cancel") return postCancel(env, req, ctx, who);
    return notFound(env);
  }
  if (method !== "GET") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST" } });

  if (p === "/style.css") return new Response(STYLE, { headers: { "Content-Type": "text/css; charset=utf-8" } });
  if (p === "/robots.txt") return new Response(ROBOTS_TXT, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  if (p === "/privacy") return page(env, "Privacy", PRIVACY(env) + `<p><a href="/">Back</a></p>`);
  if (p === "/verify") {
    const c = url.searchParams.get("c") ?? "";
    return /^[a-f0-9]{48}$/.test(c) ? verifyPage(env, c) : expiredPage(env);
  }

  const who = await signedIn(env, req);
  if (p === "/") return who ? redirect("/slots") : signInPage(env);
  if (p === "/slots") return who ? slotsPage(env, who) : redirect("/");
  if (p === "/book") {
    if (!who) return redirect("/");
    const start = parseIso(url.searchParams.get("start"));
    return start === null ? redirect("/slots") : confirmPage(env, who, start);
  }
  return notFound(env);
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const hosts = env.HOSTS.split(",").map((h) => h.trim()).filter(Boolean);
    if (!hosts.includes(url.hostname)) return withSecurity(notFound(env));
    if (!(await env.RL_GLOBAL.limit({ key: limitKey(req) })).success) {
      ctx.waitUntil(logThrottled(env, req, "ratelimited", { detail: `${req.method} ${url.pathname}`.slice(0, 200) }));
      return withSecurity(tooMany(env));
    }
    // A client deny-listed by hand (see README) is kept out of everything.
    if (await isDenied(env, limitKey(req))) {
      ctx.waitUntil(logThrottled(env, req, "network_blocked"));
      return withSecurity(page(env, "Blocked", "<h1>Access blocked</h1><p>Your network is blocked from this page for now.</p>", { status: 403 }));
    }
    return withSecurity(await route(req, env, url, ctx));
  },
};
