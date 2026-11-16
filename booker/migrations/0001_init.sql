-- Meeting booker, first schema. The sign-in tables are sat-fordhamprep's (site/migrations/
-- 0001_init.sql): codes, bindings and session ids are stored only as sha256, and the audit
-- trail (event) is kept as a security record.

CREATE TABLE otp (
  challenge     TEXT PRIMARY KEY,           -- 24 random bytes, hex; in the code-entry URL
  email         TEXT,                       -- NULL for a decoy (address not allowed)
  email_hash    TEXT NOT NULL,              -- sha256 of the mailbox (+tags folded), for the hourly cap
  code_hash     TEXT,                       -- sha256(challenge:code); NULL for a decoy
  binding_hash  TEXT NOT NULL,              -- sha256 of the __Host-mb_b cookie
  created_at    INTEGER NOT NULL,           -- unix seconds
  expires_at    INTEGER NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  consumed      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX otp_by_mailbox ON otp(email_hash, created_at);

CREATE TABLE session (
  id_hash     TEXT PRIMARY KEY,             -- sha256 of the __Host-mb_s cookie
  email       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX session_by_email ON session(email);

CREATE TABLE event (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       TEXT NOT NULL,                   -- ISO 8601
  kind     TEXT NOT NULL,
  email    TEXT,
  mb_hash  TEXT,
  detail   TEXT,
  ip       TEXT,
  ip_key   TEXT,                            -- IPv4, or the IPv6 /64
  country  TEXT,
  ua       TEXT
);
CREATE INDEX event_by_kind ON event(kind, at);
CREATE INDEX event_by_mb ON event(mb_hash, kind, at);

CREATE TABLE denylist (
  subject     TEXT PRIMARY KEY,             -- "ip:…", "ip6:…::/64" or "mb:<sha256 of mailbox>"
  label       TEXT,
  until       INTEGER NOT NULL,
  reason      TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE booking (
  id          TEXT PRIMARY KEY,             -- random; also the invitation UID
  start_utc   TEXT NOT NULL,                -- ISO 8601, e.g. 2026-12-03T21:00:00Z
  end_utc     TEXT NOT NULL,
  email       TEXT NOT NULL,                -- who booked
  note        TEXT,
  created_at  TEXT NOT NULL,
  cancelled   INTEGER NOT NULL DEFAULT 0
);
-- One live booking per start time: two people clicking the same slot, one insert wins.
CREATE UNIQUE INDEX booking_slot ON booking(start_utc) WHERE cancelled = 0;
CREATE INDEX booking_by_email ON booking(email, cancelled, end_utc);
