-- ── Years: top-level container per con year ───────────────────────────────────
CREATE TABLE years (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,                     -- "SDCC 2027"
  con_year INTEGER NOT NULL UNIQUE,       -- 2027
  owner_clerk_user_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Backfill from existing events
INSERT OR IGNORE INTO years (name, con_year)
SELECT 'SDCC ' || year, year FROM events GROUP BY year ORDER BY year;

-- Link events to their year
ALTER TABLE events ADD COLUMN year_id INTEGER REFERENCES years(id);
UPDATE events SET year_id = (SELECT id FROM years WHERE years.con_year = events.year);

-- ── Year Members: registered users with logins ─────────────────────────────────
CREATE TABLE year_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  year_id INTEGER NOT NULL REFERENCES years(id) ON DELETE CASCADE,
  clerk_user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'registered' CHECK(role IN ('owner', 'admin', 'registered')),
  sponsor_clerk_user_id TEXT,             -- who invited them (NULL for owner/admin)
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  member_id TEXT NOT NULL DEFAULT '',
  badge_type TEXT NOT NULL DEFAULT 'ADULT' CHECK(badge_type IN ('ADULT', 'JUNIOR')),
  return_eligible INTEGER NOT NULL DEFAULT 0,
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(year_id, clerk_user_id)
);

CREATE INDEX idx_year_members_year ON year_members(year_id);
CREATE INDEX idx_year_members_clerk ON year_members(clerk_user_id);
CREATE INDEX idx_year_members_member_id ON year_members(year_id, member_id);

-- ── Invites: per-user invite codes ────────────────────────────────────────────
CREATE TABLE invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  year_id INTEGER NOT NULL REFERENCES years(id) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE,              -- 12-char alphanumeric token
  label TEXT NOT NULL DEFAULT '',         -- who you sent it to (for tracking)
  invited_by_clerk_user_id TEXT NOT NULL,
  used_by_clerk_user_id TEXT,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_invites_code ON invites(code);
CREATE INDEX idx_invites_year ON invites(year_id);

-- ── Group ownership ────────────────────────────────────────────────────────────
ALTER TABLE groups ADD COLUMN owner_clerk_user_id TEXT NOT NULL DEFAULT '';

-- ── Profiles (may already exist in production) ────────────────────────────────
CREATE TABLE IF NOT EXISTS profiles (
  clerk_user_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT '',
  venmo TEXT NOT NULL DEFAULT '',
  paypal TEXT NOT NULL DEFAULT '',
  zelle TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
