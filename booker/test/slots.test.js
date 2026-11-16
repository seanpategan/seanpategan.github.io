import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHours, openSlots } from "../src/slots.js";
import { wallToUtc, iso, parseIso, whenText } from "../src/time.js";

const NY = "America/New_York";
const T = (s) => Date.parse(s);

test("HOURS parses ranges, single days and wrap-around", () => {
  const w = parseHours("Mon-Fri 16:00-19:00, Sat 10:00-13:00");
  assert.deepEqual(w[1], [[960, 1140]]);
  assert.deepEqual(w[5], [[960, 1140]]);
  assert.deepEqual(w[6], [[600, 780]]);
  assert.deepEqual(w[0], []);
  const wrap = parseHours("Fri-Mon 09:00-10:00");
  assert.deepEqual([0, 1, 5, 6].map((d) => wrap[d].length), [1, 1, 1, 1]);
  assert.equal(wrap[3].length, 0);
});

test("HOURS rejects typos instead of offering nothing", () => {
  assert.throws(() => parseHours("Mon-Fry 16:00-19:00"));
  assert.throws(() => parseHours("Mon 19:00-16:00"));
  assert.throws(() => parseHours("Mon 4pm-7pm"));
});

test("wall clock to UTC across both clock changes", () => {
  // Summer (EDT, UTC-4) and winter (EST, UTC-5).
  assert.equal(iso(wallToUtc(2026, 7, 1, 16, 0, NY)), "2026-07-01T20:00:00Z");
  assert.equal(iso(wallToUtc(2026, 12, 3, 16, 0, NY)), "2026-12-03T21:00:00Z");
  // First Sunday of November 2026 (Nov 1): 1:30 happens twice; the first one (EDT) is used.
  assert.equal(iso(wallToUtc(2026, 11, 1, 1, 30, NY)), "2026-11-01T05:30:00Z");
  assert.equal(iso(wallToUtc(2026, 11, 1, 16, 0, NY)), "2026-11-01T21:00:00Z");
  // Second Sunday of March 2027 (Mar 14): 2:30 never happens.
  assert.equal(wallToUtc(2027, 3, 14, 2, 30, NY), null);
  assert.equal(iso(wallToUtc(2027, 3, 14, 16, 0, NY)), "2027-03-14T20:00:00Z");
});

test("slots are 4 PM local on both sides of the November change", () => {
  const hours = parseHours("Sat-Sun 16:00-17:00");
  const s = openSlots({ now: T("2026-10-30T12:00:00Z"), hours, slotMin: 30, leadH: 0, horizonD: 3, tz: NY });
  assert.deepEqual(s.map((x) => iso(x.start)), [
    "2026-10-31T20:00:00Z", "2026-10-31T20:30:00Z",     // Sat, EDT
    "2026-11-01T21:00:00Z", "2026-11-01T21:30:00Z",     // Sun, EST
  ]);
  assert.match(whenText(s[2].start, NY), /Sunday, November 1 at 4:00\s?PM EST/);
});

test("slots are 4 PM local on both sides of the March change", () => {
  const hours = parseHours("Sat-Sun 16:00-16:30");
  const s = openSlots({ now: T("2027-03-12T12:00:00Z"), hours, slotMin: 30, leadH: 0, horizonD: 3, tz: NY });
  assert.deepEqual(s.map((x) => iso(x.start)), ["2027-03-13T21:00:00Z", "2027-03-14T20:00:00Z"]);
});

test("lead time, horizon, bookings and busy blocks remove slots", () => {
  const hours = parseHours("Mon-Fri 16:00-18:00");
  const now = T("2026-12-01T14:00:00Z");      // Tue 9 AM in New York
  const all = openSlots({ now, hours, slotMin: 30, leadH: 0, horizonD: 1, tz: NY });
  assert.deepEqual(all.map((x) => iso(x.start)).slice(0, 4),
    ["2026-12-01T21:00:00Z", "2026-12-01T21:30:00Z", "2026-12-01T22:00:00Z", "2026-12-01T22:30:00Z"]);

  const lead = openSlots({ now, hours, slotMin: 30, leadH: 24, horizonD: 2, tz: NY });
  assert.equal(iso(lead[0].start), "2026-12-02T21:00:00Z");

  const some = openSlots({ now, hours, slotMin: 30, leadH: 0, horizonD: 1, tz: NY,
    booked: new Set([T("2026-12-01T21:00:00Z")]),
    busy: [[T("2026-12-01T21:45:00Z"), T("2026-12-01T22:15:00Z")]] });   // overlaps 4:30 and 5:00
  assert.deepEqual(some.map((x) => iso(x.start)).filter((s) => s.startsWith("2026-12-01")), ["2026-12-01T22:30:00Z"]);
  // The horizon: nothing more than HORIZON_DAYS out, so 0 days means nothing at all.
  assert.deepEqual(openSlots({ now, hours, slotMin: 30, leadH: 0, horizonD: 0, tz: NY }), []);
});

test("parseIso accepts only the stored form", () => {
  assert.equal(parseIso("2026-12-03T21:00:00Z"), T("2026-12-03T21:00:00Z"));
  for (const bad of ["2026-12-03T21:00:00.000Z", "2026-12-03T21:00:00+00:00", "2026-02-30T21:00:00Z", "", null, "x"]) {
    assert.equal(parseIso(bad), null, String(bad));
  }
});
