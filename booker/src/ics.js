// Busy times from a calendar's private iCal feed (Google Calendar: Settings -> your calendar ->
// "Secret address in iCal format"). Pure, so test/ics.test.js runs it under Node.
//
// Handles what a personal calendar feed actually contains: UTC, TZID and floating times,
// all-day events, DURATION, events marked free (TRANSP:TRANSPARENT) or cancelled, and repeating
// events (RRULE: DAILY, WEEKLY with BYDAY, MONTHLY by day or by "2nd Tuesday", YEARLY) with
// EXDATE and moved single occurrences (RECURRENCE-ID). Anything it can't read is skipped.

import { wallToUtc, addDays, validZone } from "./time.js";

const DAY_MS = 86_400_000;
const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const MAX_STEPS = 20_000;     // safety net for a rule with no end

/** One content line: NAME;PARAM=x;PARAM="y:z":value */
function parseLine(line) {
  let i = 0, quoted = false;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === ":" && !quoted) break;
  }
  if (i >= line.length) return null;
  const [name, ...rawParams] = line.slice(0, i).split(";");
  const params = {};
  for (const p of rawParams) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: name.toUpperCase(), params, value: line.slice(i + 1) };
}

/** The VEVENTs in a feed, each a map of property name -> [{ params, value }]. */
function events(text) {
  const lines = String(text).replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const out = [];
  let cur = null, depth = 0;
  for (const line of lines) {
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === "BEGIN" && p.value.toUpperCase() === "VEVENT") { cur = new Map(); depth = 0; continue; }
    if (!cur) continue;
    // A VALARM inside the event has its own properties; skip them.
    if (p.name === "BEGIN") { depth++; continue; }
    if (p.name === "END" && depth > 0) { depth--; continue; }
    if (p.name === "END" && p.value.toUpperCase() === "VEVENT") { out.push(cur); cur = null; continue; }
    if (depth > 0) continue;
    if (!cur.has(p.name)) cur.set(p.name, []);
    cur.get(p.name).push(p);
  }
  return out;
}

/**
 * A DATE or DATE-TIME value: { allDay, utc } for a fixed instant, or { allDay, wall, tz } for
 * a wall-clock time in a zone (or a whole day, when allDay). Null if unreadable.
 */
function parseDate(value, params, defaultTz) {
  const v = value.trim();
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (m || params.VALUE === "DATE") {
    if (!m) return null;
    return { allDay: true, wall: { y: +m[1], mo: +m[2], d: +m[3], h: 0, mi: 0, s: 0 }, tz: defaultTz };
  }
  m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (!m) return null;
  const wall = { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +m[6] };
  if (m[7]) return { allDay: false, utc: Date.UTC(wall.y, wall.mo - 1, wall.d, wall.h, wall.mi, wall.s), wall, tz: "UTC" };
  const tz = params.TZID && validZone(params.TZID) ? params.TZID : defaultTz;
  return { allDay: false, wall, tz };
}

/** The instant of a parsed date, moved to another civil day (for repeats). Null if that time never happens. */
function instant(dt, day = dt.wall) {
  if (dt.tz === "UTC") return Date.UTC(day.y, day.mo - 1, day.d, dt.wall.h, dt.wall.mi, dt.wall.s);
  const t = wallToUtc(day.y, day.mo, day.d, dt.wall.h, dt.wall.mi, dt.tz, dt.wall.s);
  // A time the clocks skip happens an hour later, as calendar apps show it.
  return t ?? wallToUtc(day.y, day.mo, day.d, dt.wall.h + 1, dt.wall.mi, dt.tz, dt.wall.s);
}

/** P1DT2H30M -> ms; null if unreadable. */
function parseDuration(v) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return null;
  const ms = ((+(m[2] ?? 0) * 7 + +(m[3] ?? 0)) * 24 * 3600 + +(m[4] ?? 0) * 3600 + +(m[5] ?? 0) * 60 + +(m[6] ?? 0)) * 1000;
  return m[1] === "-" ? -ms : ms;
}

function parseRule(v) {
  const r = {};
  for (const part of v.split(";")) {
    const [k, val] = part.split("=");
    if (k && val !== undefined) r[k.toUpperCase()] = val.toUpperCase();
  }
  return r;
}

/** Days from the Unix epoch's civil day for y-mo-d. */
const dayNumber = (y, mo, d) => Math.floor(Date.UTC(y, mo - 1, d) / DAY_MS);
const fromDayNumber = (n) => addDays(1970, 1, 1, n);

/** The days of one month a MONTHLY rule picks (BYDAY with an ordinal, BYMONTHDAY, or the start's day). */
function monthDays(y, mo, rule, startDay) {
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const days = [];
  if (rule.BYDAY) {
    for (const tok of rule.BYDAY.split(",")) {
      const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(tok);
      if (!m) continue;
      const wd = WEEKDAYS.indexOf(m[2]);
      const matches = [];
      for (let d = 1; d <= last; d++) if (new Date(Date.UTC(y, mo - 1, d)).getUTCDay() === wd) matches.push(d);
      if (!m[1]) days.push(...matches);
      else {
        const n = Number(m[1]);
        const d = n > 0 ? matches[n - 1] : matches[matches.length + n];
        if (d) days.push(d);
      }
    }
  } else if (rule.BYMONTHDAY) {
    for (const tok of rule.BYMONTHDAY.split(",")) {
      const n = Number(tok);
      const d = n > 0 ? n : last + n + 1;
      if (Number.isInteger(n) && d >= 1 && d <= last) days.push(d);
    }
  } else if (startDay <= last) days.push(startDay);
  return [...new Set(days)].sort((a, b) => a - b);
}

/**
 * The civil days a repeating event happens on, from its first day, in order, until `toDay`
 * (a day number) or the rule's COUNT/UNTIL. `untilOk(day)` says whether a day is within UNTIL.
 */
function* repeatDays(start, rule, toDay, untilOk) {
  const interval = Math.max(1, Number(rule.INTERVAL) || 1);
  const count = rule.COUNT ? Number(rule.COUNT) : Infinity;
  const startN = dayNumber(start.y, start.mo, start.d);
  let made = 0, steps = 0;
  const emit = function* (n) {
    if (n < startN) return false;
    if (n > toDay || made >= count) return true;
    const day = fromDayNumber(n);
    if (!untilOk(day)) return true;
    made++;
    yield day;
    return false;
  };
  const byWeekday = rule.BYDAY ? rule.BYDAY.split(",").map((t) => WEEKDAYS.indexOf(t.replace(/^[+-]?\d+/, ""))).filter((i) => i >= 0) : null;

  if (rule.FREQ === "DAILY") {
    for (let n = startN; steps++ < MAX_STEPS; n += interval) {
      if (byWeekday && !byWeekday.includes(fromDayNumber(n).wd)) { if (n > toDay) return; continue; }
      if (yield* emit(n)) return;
    }
  } else if (rule.FREQ === "WEEKLY") {
    const wkst = WEEKDAYS.indexOf(rule.WKST ?? "MO");
    const wds = byWeekday?.length ? byWeekday : [fromDayNumber(startN).wd];
    const offsets = wds.map((wd) => (wd - wkst + 7) % 7).sort((a, b) => a - b);
    const weekStart = startN - ((fromDayNumber(startN).wd - wkst + 7) % 7);
    for (let w = weekStart; steps++ < MAX_STEPS; w += 7 * interval) {
      for (const o of offsets) if (yield* emit(w + o)) return;
    }
  } else if (rule.FREQ === "MONTHLY") {
    for (let k = 0; steps++ < MAX_STEPS; k += interval) {
      const y = start.y + Math.floor((start.mo - 1 + k) / 12), mo = ((start.mo - 1 + k) % 12) + 1;
      if (dayNumber(y, mo, 1) > toDay) return;
      for (const d of monthDays(y, mo, rule, start.d)) if (yield* emit(dayNumber(y, mo, d))) return;
    }
  } else if (rule.FREQ === "YEARLY") {
    for (let k = 0; steps++ < MAX_STEPS; k += interval) {
      const y = start.y + k;
      if (dayNumber(y, 1, 1) > toDay) return;
      // Feb 29 happens only in leap years.
      if (new Date(Date.UTC(y, start.mo - 1, start.d)).getUTCMonth() !== start.mo - 1) continue;
      if (yield* emit(dayNumber(y, start.mo, start.d))) return;
    }
  }
}

/**
 * Busy [start, end) intervals (UTC ms) overlapping [fromMs, toMs), merged and sorted.
 * `tz` is used for floating times, all-day events and unknown zone names.
 */
export function busyFromIcs(text, tz, fromMs, toMs) {
  const evs = events(text);
  const first = (ev, name) => ev.get(name)?.[0];
  const busy = [];
  const add = (s, e) => { if (s < toMs && e > fromMs && e > s) busy.push([s, e]); };

  // Single occurrences that were moved or cancelled: UID -> the original start instants they replace.
  const moved = new Map();
  for (const ev of evs) {
    const rid = first(ev, "RECURRENCE-ID"), uid = first(ev, "UID")?.value;
    if (!rid || !uid) continue;
    const dt = parseDate(rid.value, rid.params, tz);
    if (!dt) continue;
    if (!moved.has(uid)) moved.set(uid, new Set());
    moved.get(uid).add(dt.allDay ? instant({ ...dt, tz }) : dt.utc ?? instant(dt));
  }

  for (const ev of evs) {
    if ((first(ev, "STATUS")?.value ?? "").toUpperCase() === "CANCELLED") continue;
    if ((first(ev, "TRANSP")?.value ?? "").toUpperCase() === "TRANSPARENT") continue;
    const ds = first(ev, "DTSTART");
    const start = ds && parseDate(ds.value, ds.params, tz);
    if (!start) continue;

    // How long each occurrence lasts: in days for all-day events, in ms otherwise.
    const de = first(ev, "DTEND"), dur = first(ev, "DURATION");
    const end = de && parseDate(de.value, de.params, tz);
    let lengthDays = 1, lengthMs = 0;
    if (start.allDay) {
      if (end?.allDay) lengthDays = dayNumber(end.wall.y, end.wall.mo, end.wall.d) - dayNumber(start.wall.y, start.wall.mo, start.wall.d);
      else if (dur) lengthDays = Math.round((parseDuration(dur.value) ?? DAY_MS) / DAY_MS);
      lengthDays = Math.max(1, lengthDays);
    } else if (end && !end.allDay) {
      lengthMs = (end.utc ?? instant(end)) - (start.utc ?? instant(start));
    } else if (dur) {
      lengthMs = parseDuration(dur.value) ?? 0;
    }
    if (!(lengthMs >= 0)) continue;

    const occurrence = (day) => {
      if (start.allDay) {
        const s = wallToUtc(day.y, day.mo, day.d, 0, 0, tz);
        const nd = addDays(day.y, day.mo, day.d, lengthDays);
        return [s, wallToUtc(nd.y, nd.mo, nd.d, 0, 0, tz)];
      }
      const s = instant(start, day);
      return [s, s + lengthMs];
    };

    const rr = first(ev, "RRULE");
    if (!rr || first(ev, "RECURRENCE-ID")) {
      const [s, e] = occurrence(start.wall);
      add(s, e);
      continue;
    }

    const rule = parseRule(rr.value);
    const skip = new Set(moved.get(first(ev, "UID")?.value) ?? []);
    for (const ex of ev.get("EXDATE") ?? []) {
      for (const v of ex.value.split(",")) {
        const dt = parseDate(v, ex.params, start.tz === "UTC" ? tz : start.tz);
        if (dt) skip.add(dt.allDay ? (start.allDay ? occurrence(dt.wall)[0] : instant(start, dt.wall)) : dt.utc ?? instant(dt));
      }
    }
    let untilOk = () => true;
    if (rule.UNTIL) {
      const u = parseDate(rule.UNTIL, {}, tz);
      if (u) {
        const limit = u.allDay ? null : u.utc ?? instant(u);
        const limitDay = dayNumber(u.wall.y, u.wall.mo, u.wall.d);
        untilOk = limit === null
          ? (day) => dayNumber(day.y, day.mo, day.d) <= limitDay
          : (day) => occurrence(day)[0] <= limit;
      }
    }
    // Repeats are walked by civil day in the event's own zone (occurrence -> instant), so
    // 4 PM stays 4 PM across a clock change.
    const lastDay = dayNumber(new Date(toMs).getUTCFullYear(), new Date(toMs).getUTCMonth() + 1, new Date(toMs).getUTCDate()) + 1;
    const firstUseful = Math.floor(fromMs / DAY_MS) - (lengthDays + Math.ceil(lengthMs / DAY_MS) + 2);
    for (const day of repeatDays(start.wall, rule, lastDay, (d) => dayNumber(d.y, d.mo, d.d) < firstUseful || untilOk(d))) {
      if (dayNumber(day.y, day.mo, day.d) < firstUseful) continue;   // long before the window: counted, not converted
      const [s, e] = occurrence(day);
      if (s === null || skip.has(s)) continue;
      add(s, e);
    }
  }

  busy.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [s, e] of busy) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged;
}
