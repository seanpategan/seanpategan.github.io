// The calendar invitation (.ics) sent to the booker and to the owner. Pure, so
// test/invite.test.js runs it under Node.
//
// METHOD:REQUEST shows as an invite with Yes/No/Maybe in Gmail, Apple Mail and Outlook.
// The UID stays the booking's for its whole life: a cancellation is the same UID with
// METHOD:CANCEL and a higher SEQUENCE.

const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");   // 20261203T210000Z

/** TEXT value escaping (RFC 5545 3.3.11). */
const text = (s) => String(s).replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\r?\n/g, "\\n");

/** Fold a line at 75 octets, never inside a UTF-8 character (RFC 5545 3.1). */
export function fold(line) {
  const enc = new TextEncoder();
  const out = [];
  let cur = "", bytes = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (bytes + n > (out.length ? 74 : 75)) { out.push(cur); cur = ""; bytes = 0; }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}

/**
 * b: { id, start, end (ms), email, note }
 * o: { host, ownerName, ownerEmail, cancel }
 */
export function invite(b, o) {
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//seanpategan//meetings//EN", "CALSCALE:GREGORIAN",
    `METHOD:${o.cancel ? "CANCEL" : "REQUEST"}`,
    "BEGIN:VEVENT",
    `UID:${b.id}@${o.host}`,
    `DTSTAMP:${stamp(Date.now())}`,
    `DTSTART:${stamp(b.start)}`,
    `DTEND:${stamp(b.end)}`,
    `SUMMARY:${text(`Meeting with ${o.ownerName}`)}`,
    ...(b.note ? [`DESCRIPTION:${text(b.note)}`] : []),
    `ORGANIZER;CN=${text(o.ownerName)}:mailto:${o.ownerEmail}`,
    `ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${b.email}`,
    `ATTENDEE;ROLE=CHAIR;PARTSTAT=ACCEPTED:mailto:${o.ownerEmail}`,
    `STATUS:${o.cancel ? "CANCELLED" : "CONFIRMED"}`,
    `SEQUENCE:${o.cancel ? 1 : 0}`,
    "END:VEVENT", "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}
