-- Security phones: signed in by a one-time pairing code instead of a Gmail account.
-- Only SHA-256 hashes of the phone tokens and codes are stored.

CREATE TABLE IF NOT EXISTS devices (
  id          TEXT PRIMARY KEY,
  label       TEXT NOT NULL,                 -- e.g. "Security – Lakshmi"
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen   TEXT,
  revoked_at  TEXT
);

CREATE TABLE IF NOT EXISTS pair_codes (
  code_hash   TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
