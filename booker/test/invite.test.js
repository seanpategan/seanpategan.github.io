import { test } from "node:test";
import assert from "node:assert/strict";
import { invite, fold } from "../src/invite.js";
import { parseEmail, mayBook, mailboxOf, allowList } from "../src/access.js";

const b = { id: "ab".repeat(16), start: Date.parse("2026-12-03T21:00:00Z"), end: Date.parse("2026-12-03T21:30:00Z"),
  email: "guest@example.org", note: "College; questions, mostly\nand a second line" };
const o = { host: "book.example.com", ownerName: "Sean Egan", ownerEmail: "owner@example.com",
  fromAddress: "noreply@book.example.com", meetUrl: "https://meet.jit.si/seane-abab" };

test("an invitation is a REQUEST with CRLF lines, folded at 75 octets", () => {
  const ics = invite(b, o);
  assert.ok(ics.endsWith("\r\n"));
  assert.ok(!/[^\r]\n/.test(ics), "bare LF");
  for (const line of ics.split("\r\n")) assert.ok(new TextEncoder().encode(line).length <= 75, line);
  const unfolded = ics.replace(/\r\n /g, "");
  assert.match(unfolded, /METHOD:REQUEST/);
  assert.match(unfolded, /UID:abab.*@book\.example\.com/);
  assert.match(unfolded, /DTSTART:20261203T210000Z\r\nDTEND:20261203T213000Z/);
  assert.match(unfolded, /DESCRIPTION:Join in your browser: https:\/\/meet\.jit\.si\/seane-abab\\n\\nCollege\\; questions\\, mostly\\nand a second line/);
  assert.match(unfolded, /LOCATION:https:\/\/meet\.jit\.si\/seane-abab/);
  // The booker's own address organizes; the owner and the guest are both attendees.
  assert.match(unfolded, /ORGANIZER;CN=Sean Egan:mailto:noreply@book\.example\.com/);
  assert.match(unfolded, /ATTENDEE;CN=Sean Egan;[^:]*:mailto:owner@example\.com/);
  assert.match(unfolded, /ATTENDEE;CN=guest@example\.org;[^:]*:mailto:guest@example\.org/);
  assert.match(unfolded, /STATUS:CONFIRMED\r\nSEQUENCE:0/);
});

test("no Meet link, no note: no LOCATION or DESCRIPTION; booking yourself lists you once", () => {
  const ics = invite({ ...b, note: "", email: "owner@example.com" }, { ...o, meetUrl: "" }).replace(/\r\n /g, "");
  assert.doesNotMatch(ics, /LOCATION|DESCRIPTION/);
  assert.equal(ics.match(/^ATTENDEE/gm).length, 1);
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
  assert.deepEqual(allowList(env), { emails: ["owner@example.com", "friend.one@example.com"], domains: ["school.example.edu"], suffixes: [] });
  for (const ok of ["owner@example.com", " Friend.One@Example.com ", "anyone@school.example.edu"]) {
    assert.ok(mayBook(parseEmail(ok), env), ok);
  }
  for (const no of ["friendone@example.com", "friend.one+x@example.com", "friend.one@x.example.com",
    "someone@example.com", "friend.one@example.com.evil.com", "friend.one@exаmple.com", "x@sub.school.example.edu", "", null]) {
    assert.ok(!mayBook(parseEmail(no), env), String(no));
  }
  assert.ok(!mayBook("owner@example.com", {}), "no secret set: nobody");
  // ".edu": any domain ending in .edu, at a label boundary.
  const edu = { ALLOW_EMAILS: ".edu, ., .-bad-, @*., @gmail.com" };
  assert.deepEqual(allowList(edu).suffixes, [".edu"]);
  assert.deepEqual(allowList({ ALLOW_EMAILS: "@*.edu" }), allowList({ ALLOW_EMAILS: ".edu" }));
  for (const ok of ["a@cooper.edu", "b@mail.columbia.edu", "c@gmail.com"]) assert.ok(mayBook(parseEmail(ok), edu), ok);
  for (const no of ["a@notedu.com", "a@edu.evil.com", "a@cooper.edu.evil.com", "a@cooperedu", "a@yahoo.com"]) {
    assert.ok(!mayBook(parseEmail(no), edu), no);
  }
  assert.equal(mailboxOf("friend.one+test@example.com"), "friend.one@example.com");
});
