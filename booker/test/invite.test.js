import { test } from "node:test";
import assert from "node:assert/strict";
import { invite, fold } from "../src/invite.js";
import { parseEmail, mayBook, mailboxOf, allowList } from "../src/access.js";

const b = { id: "ab".repeat(16), start: Date.parse("2026-12-03T21:00:00Z"), end: Date.parse("2026-12-03T21:30:00Z"),
  email: "guest@example.org", note: "College; questions, mostly\nand a second line" };
const o = { host: "book.example.com", ownerName: "Sean Egan", ownerEmail: "owner@example.com" };

test("an invitation is a REQUEST with CRLF lines, folded at 75 octets", () => {
  const ics = invite(b, o);
  assert.ok(ics.endsWith("\r\n"));
  assert.ok(!/[^\r]\n/.test(ics), "bare LF");
  for (const line of ics.split("\r\n")) assert.ok(new TextEncoder().encode(line).length <= 75, line);
  const unfolded = ics.replace(/\r\n /g, "");
  assert.match(unfolded, /METHOD:REQUEST/);
  assert.match(unfolded, /UID:abab.*@book\.example\.com/);
  assert.match(unfolded, /DTSTART:20261203T210000Z\r\nDTEND:20261203T213000Z/);
  assert.match(unfolded, /DESCRIPTION:College\\; questions\\, mostly\\nand a second line/);
  assert.match(unfolded, /ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:guest@example\.org/);
  assert.match(unfolded, /STATUS:CONFIRMED\r\nSEQUENCE:0/);
});

test("a cancellation keeps the UID and raises SEQUENCE", () => {
  const ics = invite(b, { ...o, cancel: true }).replace(/\r\n /g, "");
  assert.match(ics, /METHOD:CANCEL/);
  assert.match(ics, /UID:abab.*@book\.example\.com/);
  assert.match(ics, /STATUS:CANCELLED\r\nSEQUENCE:1/);
});

test("folding never splits a multi-byte character", () => {
  const folded = fold("DESCRIPTION:" + "é".repeat(80));
  for (const line of folded.split("\r\n ")) assert.ok(!line.includes("�"));
  assert.equal(folded.replace(/\r\n /g, ""), "DESCRIPTION:" + "é".repeat(80));
});

test("the allow list comes from ALLOW_EMAILS: exact addresses, and @domain entries", () => {
  const env = { ALLOW_EMAILS: " Owner@Example.com, friend.one@example.com,@school.example.edu, not an address" };
  assert.deepEqual(allowList(env), { emails: ["owner@example.com", "friend.one@example.com"], domains: ["school.example.edu"] });
  for (const ok of ["owner@example.com", " Friend.One@Example.com ", "anyone@school.example.edu"]) {
    assert.ok(mayBook(parseEmail(ok), env), ok);
  }
  for (const no of ["friendone@example.com", "friend.one+x@example.com", "friend.one@x.example.com",
    "someone@example.com", "friend.one@example.com.evil.com", "friend.one@exаmple.com", "x@sub.school.example.edu", "", null]) {
    assert.ok(!mayBook(parseEmail(no), env), String(no));
  }
  assert.ok(!mayBook("owner@example.com", {}), "no secret set: nobody");
  assert.equal(mailboxOf("friend.one+test@example.com"), "friend.one@example.com");
});
