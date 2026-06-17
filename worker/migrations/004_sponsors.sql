-- Global sponsors table (not per-event — sponsors are consistent across years)
CREATE TABLE sponsors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- id=1 is the sentinel for "not yet assigned" — used as DEFAULT below
INSERT INTO sponsors (id, name) VALUES (1, 'Unassigned');

-- Populate from distinct existing sponsor text values
INSERT OR IGNORE INTO sponsors (name)
SELECT DISTINCT TRIM(sponsor)
FROM participants
WHERE TRIM(sponsor) != '';

-- Add sponsor_id; DEFAULT 1 covers all existing rows
-- Note: D1 doesn't allow ADD COLUMN with REFERENCES + DEFAULT, so the FK is omitted here.
-- The application layer enforces referential integrity.
ALTER TABLE participants ADD COLUMN sponsor_id INTEGER NOT NULL DEFAULT 1;

-- Map existing text → sponsor_id (case-insensitive)
UPDATE participants
SET sponsor_id = (
  SELECT s.id FROM sponsors s WHERE LOWER(s.name) = LOWER(TRIM(participants.sponsor))
)
WHERE TRIM(sponsor) != '';
