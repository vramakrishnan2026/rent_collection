-- Challaghatta Home rent app: first schema.
-- Money is stored in whole rupees (INTEGER). Dates are 'YYYY-MM-DD' in India time.

CREATE TABLE IF NOT EXISTS units (
  code        TEXT PRIMARY KEY,                -- e.g. G1, F3, T6
  floor       TEXT NOT NULL,                   -- Ground / First / Second / Third / anything added later
  sort        INTEGER NOT NULL DEFAULT 0,      -- display order
  rent_free   INTEGER NOT NULL DEFAULT 0,      -- 1 = no rent (e.g. the security guard's unit)
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- One row per tenancy (a lease on a unit). A unit has at most one open tenancy (end_date IS NULL).
CREATE TABLE IF NOT EXISTS tenancies (
  id                   TEXT PRIMARY KEY,
  unit_code            TEXT NOT NULL REFERENCES units(code),
  contact_name         TEXT NOT NULL,          -- who the rent link is addressed to
  phone                TEXT,                   -- 10-digit Indian mobile, for SMS
  whatsapp             TEXT,                   -- 10-digit Indian mobile, for WhatsApp
  start_date           TEXT NOT NULL,          -- move-in date; rent is due on this day every month
  end_date             TEXT,                   -- move-out date; NULL while living there
  base_rent            INTEGER NOT NULL CHECK (base_rent >= 0),  -- rent for the first 11 months
  deposit              INTEGER NOT NULL DEFAULT 0 CHECK (deposit >= 0), -- refundable advance
  deposit_refund       INTEGER,                -- amount given back at move-out
  deposit_refunded_on  TEXT,
  notes                TEXT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenancies_one_open ON tenancies (unit_code) WHERE end_date IS NULL;
CREATE INDEX IF NOT EXISTS idx_tenancies_unit ON tenancies (unit_code);

-- Everyone living in the unit, with their ID photo (kept in Google Drive; ID numbers are never stored).
CREATE TABLE IF NOT EXISTS people (
  id              TEXT PRIMARY KEY,
  tenancy_id      TEXT NOT NULL REFERENCES tenancies(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  id_type         TEXT,                        -- Aadhaar / PAN / Passport / Driving licence / Voter ID / Other
  drive_file_id   TEXT,
  drive_file_name TEXT,
  id_uploaded_at  TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_people_tenancy ON people (tenancy_id);

CREATE TABLE IF NOT EXISTS payments (
  id              TEXT PRIMARY KEY,
  tenancy_id      TEXT NOT NULL REFERENCES tenancies(id),
  amount          INTEGER NOT NULL CHECK (amount > 0),
  paid_on         TEXT NOT NULL,
  method          TEXT NOT NULL CHECK (method IN ('razorpay', 'upi', 'cash', 'bank', 'other')),
  reference       TEXT,
  rzp_payment_id  TEXT UNIQUE,                 -- set for Razorpay payments; stops double counting
  test            INTEGER NOT NULL DEFAULT 0,  -- 1 = made with Razorpay test keys
  note            TEXT,
  created_by      TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_payments_tenancy ON payments (tenancy_id);
CREATE INDEX IF NOT EXISTS idx_payments_date ON payments (paid_on);

-- Razorpay payment links created from the app.
CREATE TABLE IF NOT EXISTS payment_links (
  id           TEXT PRIMARY KEY,               -- Razorpay link id (plink_...)
  tenancy_id   TEXT NOT NULL REFERENCES tenancies(id),
  amount       INTEGER NOT NULL,
  description  TEXT,
  short_url    TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'created', -- created / paid / cancelled / expired
  test         INTEGER NOT NULL DEFAULT 0,
  sent_at      TEXT,
  sent_via     TEXT,                            -- whatsapp / sms
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_links_tenancy ON payment_links (tenancy_id, status);

CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT
);

-- The 24 units: Ground (G), First (F), Second (S), Third (T), 1 to 6 on each floor.
INSERT OR IGNORE INTO units (code, floor, sort) VALUES
  ('G1','Ground',101),('G2','Ground',102),('G3','Ground',103),('G4','Ground',104),('G5','Ground',105),('G6','Ground',106),
  ('F1','First',201),('F2','First',202),('F3','First',203),('F4','First',204),('F5','First',205),('F6','First',206),
  ('S1','Second',301),('S2','Second',302),('S3','Second',303),('S4','Second',304),('S5','Second',305),('S6','Second',306),
  ('T1','Third',401),('T2','Third',402),('T3','Third',403),('T4','Third',404),('T5','Third',405),('T6','Third',406);
