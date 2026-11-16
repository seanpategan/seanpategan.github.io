// Open times: the weekly hours (the HOURS var), minus anything already booked, minus busy
// blocks from the calendar feed. Pure, so test/slots.test.js runs it under Node.

import { DAYS, wallClock, wallToUtc, addDays } from "./time.js";

const MIN = 60_000;

/**
 * "Mon-Fri 16:00-19:00, Sat 10:00-13:00" -> for each weekday (0 = Sunday), its [start, end)
 * minute ranges. Throws on anything it can't read, so a typo in wrangler.jsonc fails loudly
 * instead of quietly offering no times.
 */
export function parseHours(spec) {
  const week = DAYS.map(() => []);
  const day = (name) => {
    const i = DAYS.findIndex((d) => d.toLowerCase() === name.toLowerCase());
    if (i < 0) throw new Error(`HOURS: unknown day "${name}"`);
    return i;
  };
  for (const part of String(spec ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = /^([a-z]{3})(?:-([a-z]{3}))?\s+(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/i.exec(part);
    if (!m) throw new Error(`HOURS: can't read "${part}"`);
    const from = day(m[1]);
    const to = m[2] ? day(m[2]) : from;
    const start = Number(m[3]) * 60 + Number(m[4]);
    const end = Number(m[5]) * 60 + Number(m[6]);
    if (end <= start || end > 24 * 60) throw new Error(`HOURS: "${part}" ends before it starts`);
    for (let d = from; ; d = (d + 1) % 7) {
      week[d].push([start, end]);
      if (d === to) break;
    }
  }
  return week;
}

/**
 * Every open slot as { start, end } in UTC ms, earliest first.
 *   now        the current instant
 *   hours      parseHours() of the HOURS var
 *   slotMin    SLOT_MINUTES
 *   leadH      LEAD_HOURS: nothing sooner than this
 *   horizonD   HORIZON_DAYS: nothing further out than this
 *   tz         the zone HOURS is written in
 *   booked     Set of booked start instants (ms)
 *   busy       [[start, end], ...] from the calendar feed
 */
export function openSlots({ now, hours, slotMin, leadH, horizonD, tz, booked = new Set(), busy = [] }) {
  const earliest = now + leadH * 60 * MIN;
  const latest = now + horizonD * 24 * 60 * MIN;
  const today = wallClock(now, tz);
  const out = [];
  for (let i = 0; i <= horizonD; i++) {
    const { y, mo, d, wd } = addDays(today.y, today.mo, today.d, i);
    for (const [from, to] of hours[wd]) {
      for (let m = from; m + slotMin <= to; m += slotMin) {
        const start = wallToUtc(y, mo, d, Math.floor(m / 60), m % 60, tz);
        if (start === null) continue;                       // a time the clocks skip
        const end = start + slotMin * MIN;
        if (start < earliest || start > latest || booked.has(start)) continue;
        if (busy.some(([bs, be]) => start < be && bs < end)) continue;
        out.push({ start, end });
      }
    }
  }
  return out.sort((a, b) => a.start - b.start);
}
