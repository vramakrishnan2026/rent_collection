-- ID photos taken by the security guard (or the owner) from the "Add ID" screen.
-- Each one is a file in Google Drive under the unit. The AI reads only the printed names.
-- If a name matches someone listed in the unit, the photo is attached to them automatically;
-- otherwise it waits on the unit's page for the owner to attach, add as a new person, or dismiss.

CREATE TABLE IF NOT EXISTS id_uploads (
  id             TEXT PRIMARY KEY,
  unit_code      TEXT NOT NULL REFERENCES units(code),
  tenancy_id     TEXT REFERENCES tenancies(id),    -- the tenancy open when it was taken, if any
  drive_file_id  TEXT NOT NULL,
  file_name      TEXT NOT NULL,
  names          TEXT,                              -- JSON array of names read off the card(s)
  is_pdf         INTEGER NOT NULL DEFAULT 0,
  taken_at       TEXT NOT NULL,
  uploaded_by    TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'linked', 'dismissed')),
  person_id      TEXT,                              -- who it was attached to
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_id_uploads_unit ON id_uploads (unit_code, status);
