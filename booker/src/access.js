// Who may book. Pure functions only, so the unit tests run them under Node.
//
// The shape is sat-fordhamprep's (site/src/access.ts), but the list itself is not in this
// repo: it is the Worker secret ALLOW_EMAILS (comma-separated), so nobody's address is public.
// Locally it comes from .dev.vars, which git ignores. A session only proves "this browser
// controls this address"; mayBook is checked again on every request, so changing the secret
// takes effect at once, whatever sessions exist.
//
// Exact addresses only: no dot variants, no +tags. An entry "@example.edu" admits any address
// at exactly that domain ("x.example.edu" is not admitted). An entry ".edu" or ".example.edu"
// (also written "@*.edu", "@*.example.edu") admits any domain ending in it, at a label boundary (".edu" admits "cooper.edu" and
// "mail.cooper.edu", not "notedu.com" or "edu.evil.com").

/** The ALLOW_EMAILS secret as { emails, domains, suffixes }. Anything unreadable in it is ignored. */
export function allowList(env) {
  const emails = [], domains = [], suffixes = [];
  for (const entry of String(env?.ALLOW_EMAILS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    const raw = entry.startsWith("@*.") ? entry.slice(2) : entry;   // "@*.edu" is ".edu"
    if (raw.startsWith("@")) { if (parseEmail(`x${raw}`)) domains.push(raw.slice(1)); }
    else if (raw.startsWith(".")) { if (/^(\.[a-z0-9-]{1,63})+$/.test(raw) && parseEmail(`x@x${raw}`)) suffixes.push(raw); }
    else { const e = parseEmail(raw); if (e) emails.push(e); }
  }
  return { emails, domains, suffixes };
}

/**
 * A normalized address, or null. ASCII only, so a lookalike domain written with Cyrillic or
 * full-width letters can never equal an allowed one; one @; no quoted local parts, comments,
 * IP literals, empty labels or trailing dot.
 */
export function parseEmail(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (s.length < 3 || s.length > 254) return null;
  // No "%": some mail servers still honour the old percent-hack relay (a%evil.com@host).
  const m = /^([a-z0-9._+-]{1,64})@([a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})+)$/.exec(s);
  if (!m) return null;
  const [, local, domain] = m;
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null;
  if (domain.split(".").some((l) => l.startsWith("-") || l.endsWith("-"))) return null;
  return s;
}

export const domainOf = (email) => email.slice(email.lastIndexOf("@") + 1);

/**
 * The mailbox an address lands in, for rate limits: Gmail and most hosts deliver a+anything@
 * to a@, so a per-address cap must not treat each +tag as a new address.
 */
export const mailboxOf = (email) => {
  const at = email.lastIndexOf("@");
  return email.slice(0, at).split("+")[0] + email.slice(at);
};

/** Whether this (already parsed) address may sign in and book, by the ALLOW_EMAILS secret in `env`. */
export function mayBook(email, env) {
  if (!email) return false;
  const { emails, domains, suffixes } = allowList(env);
  const domain = domainOf(email);
  return emails.includes(email) || domains.includes(domain) || suffixes.some((s) => domain.endsWith(s));
}
