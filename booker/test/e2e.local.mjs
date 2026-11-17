// End-to-end checks against `wrangler dev`: sign-in, booking, the race for one slot, cancelling.
// Local only: codes and invitations are read from the dev log, where wrangler prints mail
// instead of sending it.
//
//   npm run test:e2e
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { devServer } from "./devserver.mjs";

// Open all day, every day, so there are always times to book whenever the tests run.
// Made-up addresses only (example.com/.org never deliver): the real list is a secret, not in this repo.
const OWNER = "owner@example.com", FRIEND = "friend@example.com", GUEST = "guest@example.org";
const dev = devServer({ vars: { HOURS: "Sun-Sat 00:00-24:00", LEAD_HOURS: "1", HORIZON_DAYS: "3",
  OWNER_EMAIL: OWNER, ALLOW_EMAILS: [OWNER, FRIEND, GUEST].join(",") } });
const { base: BASE, rows } = dev;
before(() => dev.start(), { timeout: 120_000 });
after(() => dev.stop());

const FORM = { "Content-Type": "application/x-www-form-urlencoded", Origin: BASE };
const ip = () => `198.51.100.${1 + Math.floor(Math.random() * 250)}`;
const cookiesOf = (r) => Object.fromEntries(r.headers.getSetCookie().map((c) => c.split(";")[0].split("=")));
const S = (sid) => `__Host-mb_s=${sid}`;

async function get(path, cookie = "") {
  return fetch(BASE + path, { redirect: "manual", headers: { "CF-Connecting-IP": ip(), ...(cookie ? { Cookie: cookie } : {}) } });
}
async function post(path, body, cookie = "", headers = FORM) {
  if (path === "/auth/start" && !("cf-turnstile-response" in body)) body = { ...body, "cf-turnstile-response": "XXXX.DUMMY.TOKEN.XXXX" };
  return fetch(BASE + path, { method: "POST", redirect: "manual", body: new URLSearchParams(body),
    headers: { ...headers, "CF-Connecting-IP": ip(), ...(cookie ? { Cookie: cookie } : {}) } });
}

const since = new Map();
async function start(email) {
  since.set(email, dev.log().length);
  const r = await post("/auth/start", { email });
  assert.equal(r.status, 303, `start ${email}`);
  const c = new URL(r.headers.get("Location"), BASE).searchParams.get("c");
  return { c, bind: cookiesOf(r)["__Host-mb_b"] };
}
async function codeFor(email) {
  const esc = email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Other headers (Bcc, when BCC_EMAIL is set) may sit between To and Subject.
  const re = new RegExp(`To: ${esc}\\r?\\n(?:[\\w-]+: .*\\r?\\n)*?Subject: (\\d{6}) is your sign-in code`);
  for (let i = 0; i < 40; i++) {
    const m = re.exec(dev.log().slice(since.get(email) ?? 0));
    if (m) return m[1];
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}
async function signIn(email) {
  const { c, bind } = await start(email);
  const code = await codeFor(email);
  assert.ok(code, `code mailed to ${email}`);
  const r = await post("/auth/verify", { c, code }, `__Host-mb_b=${bind}`);
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("Location"), "/slots");
  return cookiesOf(r)["__Host-mb_s"];
}
/** The open times linked from /slots. */
async function openTimes(sid) {
  const html = await (await get("/slots", S(sid))).text();
  return [...html.matchAll(/href="\/book\?start=([0-9TZ:-]+)"/g)].map((m) => m[1]);
}
/**
 * Mail the dev log shows for `to` since `from`: each message's log entry, with the attachments
 * wrangler saved to disk read back in after it.
 */
const mailTo = (to, from = 0) => dev.log().slice(from).split(/(?=To: )/).filter((m) => m.startsWith(`To: ${to}`))
  .map((m) => m.split("[wrangler:info]")[0])
  .map((m) => m + [...m.matchAll(/^Attachment \(attachment\): \S+ -> (.+)$/gm)].map((a) => readFileSync(a[1].trim(), "utf8")).join(""));

test("the sign-in page is the site's page, with its stylesheet", async () => {
  const r = await get("/");
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /<header>Sean Egan<\/header>/);
  assert.match(html, /href="\/">Meetings/);
  assert.match(html, /<form method="post" action="\/auth\/start">/);
  assert.match(r.headers.get("Content-Security-Policy"), /frame-ancestors 'none'/);
  const css = await (await get("/style.css")).text();
  assert.equal(css, readFileSync(new URL("../../style.css", import.meta.url), "utf8"));
});

test("an address not on the list gets the same page and no email", async () => {
  const stranger = "someone@example.org";
  const from = dev.log().length;
  const { c, bind } = await start(stranger);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(mailTo(stranger, from).length, 0);
  const r = await post("/auth/verify", { c, code: "123456" }, `__Host-mb_b=${bind}`);
  assert.equal(r.status, 400);
  assert.match(await r.text(), /not correct/);
});

test("a code works only in the browser that asked, and pages need a session", async () => {
  const { c } = await start(FRIEND);
  const code = await codeFor(FRIEND);
  const r = await post("/auth/verify", { c, code }, "__Host-mb_b=" + "0".repeat(64));
  assert.equal(r.status, 400);
  assert.match(await r.text(), /only works in the browser/);
  assert.equal((await get("/slots")).headers.get("Location"), "/");
});

test("posts from another site are refused", async () => {
  const r = await post("/auth/start", { email: OWNER }, "", { ...FORM, Origin: "https://evil.example" });
  assert.equal(r.status, 403);
});

test("book, race for one slot, one booking each, cancel", async () => {
  const owner = await signIn(OWNER);
  const guest = await signIn(GUEST);
  const times = await openTimes(owner);
  assert.ok(times.length > 10, "open times listed");

  // Confirm page, then both post the same time at once: exactly one wins.
  const slot = times[0];
  assert.match(await (await get(`/book?start=${slot}`, S(owner))).text(), /Confirm your meeting/);
  const from = dev.log().length;
  const [a, b] = await Promise.all([
    post("/book", { start: slot, note: "College questions; mostly" }, S(owner)),
    post("/book", { start: slot }, S(guest)),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [303, 409]);
  const [winner, loser] = a.status === 303 ? [OWNER, guest] : [GUEST, owner];
  assert.equal(rows(`SELECT COUNT(*) AS n FROM booking WHERE start_utc='${slot}' AND cancelled=0`)[0].n, 1);

  // Both the booker and Sean get an invitation.
  for (let i = 0; i < 40 && !(mailTo(winner, from).length && mailTo(OWNER, from).length); i++) await new Promise((r) => setTimeout(r, 250));
  // Sean booking with himself gets one email, not two.
  if (winner === OWNER) assert.equal(mailTo(OWNER, from).length, 1);
  const toWinner = mailTo(winner, from).join("");
  assert.match(toWinner, /METHOD:REQUEST/);
  // Its own Jitsi room, in the invitation's location and description.
  assert.match(toWinner.replace(/\r\n /g, ""), /DESCRIPTION:Join in your browser: https:\/\/meet\.jit\.si\/seane-[a-f0-9]{32}/);
  assert.match(toWinner.replace(/\r\n /g, ""), /LOCATION:https:\/\/meet\.jit\.si\/seane-[a-f0-9]{32}/);
  assert.match(toWinner, /Subject: Booked: /);
  if (winner !== OWNER) assert.match(mailTo(OWNER, from).join(""), new RegExp(`Booked: .* with ${winner.replace(/\./g, "\\.")}`));

  // The taken time is no longer offered to the other person; they book another.
  const loserTimes = await openTimes(loser);
  assert.ok(!loserTimes.includes(slot));
  assert.equal((await post("/book", { start: loserTimes[0] }, S(loser))).status, 303);

  // One upcoming booking each: a second is refused.
  const winnerSid = winner === OWNER ? owner : guest;
  const page = await (await get("/slots", S(winnerSid))).text();
  assert.match(page, /You're booked for/);
  assert.equal((await post("/book", { start: loserTimes[5] }, S(winnerSid))).status, 409);

  // A time outside the open slots is refused.
  assert.equal((await post("/book", { start: "2020-01-01T15:00:00Z" }, S(winnerSid))).status, 409);

  // Cancel: the slot opens again and both get a cancellation.
  const id = page.match(/name="id" value="([a-f0-9]{32})"/)[1];
  const cfrom = dev.log().length;
  assert.equal((await post("/cancel", { id }, S(winnerSid))).status, 303);
  assert.ok((await openTimes(winnerSid)).includes(slot));
  for (let i = 0; i < 40 && !mailTo(winner, cfrom).join("").includes("METHOD:CANCEL"); i++) await new Promise((r) => setTimeout(r, 250));
  assert.match(mailTo(winner, cfrom).join(""), /METHOD:CANCEL/);
});

test("five wrong codes and the challenge is spent", async () => {
  const { c, bind } = await start(FRIEND);
  let r;
  for (let i = 0; i < 5; i++) r = await post("/auth/verify", { c, code: "000000" }, `__Host-mb_b=${bind}`);
  assert.match(await r.text(), /expired/);
  const code = await codeFor(FRIEND);
  r = await post("/auth/verify", { c, code }, `__Host-mb_b=${bind}`);
  assert.equal(r.status, 400);
});
