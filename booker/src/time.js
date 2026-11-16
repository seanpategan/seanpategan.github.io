// Time zones without a library. Everything inside the Worker is UTC milliseconds; a zone is only
// used to turn a wall-clock time ("Thursday 4:00 PM in New York") into an instant and back.

export const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MIN = 60_000;

const formatters = new Map();
function formatter(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "numeric", second: "numeric",
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Whether Intl knows this zone name (calendar feeds sometimes carry Windows names). */
export function validZone(tz) {
  try { formatter(tz); return true; } catch { return false; }
}

/** The wall clock in `tz` at instant `ms`. */
export function wallClock(ms, tz) {
  const o = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour, mi: +o.minute, s: +o.second };
}

/** How far `tz` is ahead of UTC at instant `ms`. */
function offset(ms, tz) {
  const w = wallClock(ms, tz);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant a wall-clock time in `tz` happens, or null if it never does (the hour skipped
 * when clocks go forward). An hour that happens twice (clocks going back) gives the first.
 * Day and month may overflow (d: 32), as with Date.UTC.
 */
export function wallToUtc(y, mo, d, h, mi, tz, s = 0) {
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  const first = wall - offset(wall - 12 * 60 * MIN, tz);
  const second = wall - offset(wall + 12 * 60 * MIN, tz);
  for (const t of first <= second ? [first, second] : [second, first]) {
    if (t + offset(t, tz) === wall) return t;
  }
  return null;
}

/** The civil date `days` after y-mo-d, and its weekday (0 = Sunday). */
export function addDays(y, mo, d, days) {
  const t = new Date(Date.UTC(y, mo - 1, d + days));
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), wd: t.getUTCDay() };
}

/** 2026-12-03T21:00:00Z: the form stored in D1 and used in URLs. */
export const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** An ISO instant from a URL or form, strictly in iso()'s form, or null. */
export function parseIso(raw) {
  const s = String(raw ?? "");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(s)) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) && iso(ms) === s ? ms : null;
}

/** "Thursday, December 3 at 4:00 PM EST" */
export function whenText(ms, tz) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(new Date(ms));
}

/** "Thu, Dec 3" */
export const dayText = (ms, tz) =>
  new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" }).format(new Date(ms));

/** "4:30 PM" */
export const timeText = (ms, tz) =>
  new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(ms));
