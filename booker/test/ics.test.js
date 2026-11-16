import { test } from "node:test";
import assert from "node:assert/strict";
import { busyFromIcs } from "../src/ics.js";
import { iso } from "../src/time.js";

const NY = "America/New_York";
const T = (s) => Date.parse(s);
const FROM = T("2026-11-01T00:00:00Z"), TO = T("2026-12-31T00:00:00Z");
const cal = (...events) => ["BEGIN:VCALENDAR", "VERSION:2.0", ...events.flat(), "END:VCALENDAR"].join("\r\n");
const ev = (...lines) => ["BEGIN:VEVENT", ...lines, "END:VEVENT"];
const show = (busy) => busy.map(([s, e]) => `${iso(s)} ${iso(e)}`);

test("UTC, TZID and floating times", () => {
  const busy = busyFromIcs(cal(
    ev("UID:a", "DTSTART:20261203T210000Z", "DTEND:20261203T220000Z"),
    ev("UID:b", "DTSTART;TZID=America/Los_Angeles:20261204T090000", "DTEND;TZID=America/Los_Angeles:20261204T100000"),
    ev("UID:c", "DTSTART:20261205T160000", "DURATION:PT45M"),
  ), NY, FROM, TO);
  assert.deepEqual(show(busy), [
    "2026-12-03T21:00:00Z 2026-12-03T22:00:00Z",
    "2026-12-04T17:00:00Z 2026-12-04T18:00:00Z",
    "2026-12-05T21:00:00Z 2026-12-05T21:45:00Z",
  ]);
});

test("free, cancelled and unknown-zone events", () => {
  const busy = busyFromIcs(cal(
    ev("UID:a", "DTSTART:20261203T210000Z", "DTEND:20261203T220000Z", "TRANSP:TRANSPARENT"),
    ev("UID:b", "DTSTART:20261203T210000Z", "DTEND:20261203T220000Z", "STATUS:CANCELLED"),
    // Outlook writes Windows zone names; they fall back to the page's zone.
    ev("UID:c", "DTSTART;TZID=Eastern Standard Time:20261203T160000", "DTEND;TZID=Eastern Standard Time:20261203T170000"),
  ), NY, FROM, TO);
  assert.deepEqual(show(busy), ["2026-12-03T21:00:00Z 2026-12-03T22:00:00Z"]);
});

test("all-day events cover whole local days; folded lines and alarms are read", () => {
  const busy = busyFromIcs(cal(
    ev("UID:a", "DTSTART;VALUE=DATE:20261224", "DTEND;VALUE=DATE:20261226",
      "SUMMARY:A long summary that is folded",
      " onto a second line", "BEGIN:VALARM", "TRIGGER:-PT15M", "DTSTART:20200101T000000Z", "END:VALARM"),
  ), NY, FROM, TO);
  assert.deepEqual(show(busy), ["2026-12-24T05:00:00Z 2026-12-26T05:00:00Z"]);
});

test("weekly repeats keep local time across the clock change, with EXDATE and a moved occurrence", () => {
  const busy = busyFromIcs(cal(
    ev("UID:practice", "DTSTART;TZID=America/New_York:20261021T160000", "DTEND;TZID=America/New_York:20261021T173000",
      "RRULE:FREQ=WEEKLY;BYDAY=WE;UNTIL=20261118T235959Z",
      "EXDATE;TZID=America/New_York:20261111T160000"),
    // The Nov 18 practice moved to Thursday.
    ev("UID:practice", "RECURRENCE-ID;TZID=America/New_York:20261118T160000",
      "DTSTART;TZID=America/New_York:20261119T160000", "DTEND;TZID=America/New_York:20261119T173000"),
  ), NY, FROM, TO);
  assert.deepEqual(show(busy), [
    "2026-11-04T21:00:00Z 2026-11-04T22:30:00Z",   // EST now: 4 PM is 21:00Z
    "2026-11-19T21:00:00Z 2026-11-19T22:30:00Z",   // the moved one; Nov 11 excluded, Nov 18 replaced
  ]);
});

test("daily COUNT counts from the first occurrence, not the window", () => {
  const busy = busyFromIcs(cal(
    ev("UID:a", "DTSTART:20261028T150000Z", "DTEND:20261028T160000Z", "RRULE:FREQ=DAILY;COUNT=7"),
  ), NY, FROM, TO);
  // Oct 28 .. Nov 3: only Nov 1-3 are in the window.
  assert.deepEqual(show(busy).map((s) => s.slice(0, 10)), ["2026-11-01", "2026-11-02", "2026-11-03"]);
});

test("monthly by ordinal weekday, and yearly", () => {
  const busy = busyFromIcs(cal(
    ev("UID:m", "DTSTART;TZID=America/New_York:20260908T190000", "DTEND;TZID=America/New_York:20260908T200000",
      "RRULE:FREQ=MONTHLY;BYDAY=2TU"),
    ev("UID:y", "DTSTART;VALUE=DATE:20201215", "RRULE:FREQ=YEARLY"),
  ), NY, FROM, TO);
  assert.deepEqual(show(busy), [
    "2026-11-11T00:00:00Z 2026-11-11T01:00:00Z",   // 2nd Tuesday of Nov: Nov 10, 7 PM EST
    "2026-12-09T00:00:00Z 2026-12-09T01:00:00Z",   // 2nd Tuesday of Dec: Dec 8
    "2026-12-15T05:00:00Z 2026-12-16T05:00:00Z",
  ]);
});

test("overlapping blocks are merged", () => {
  const busy = busyFromIcs(cal(
    ev("UID:a", "DTSTART:20261203T210000Z", "DTEND:20261203T220000Z"),
    ev("UID:b", "DTSTART:20261203T213000Z", "DTEND:20261203T223000Z"),
  ), NY, FROM, TO);
  assert.deepEqual(show(busy), ["2026-12-03T21:00:00Z 2026-12-03T22:30:00Z"]);
});
