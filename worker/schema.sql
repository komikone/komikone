-- KomikOne D1 Schema

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  year INTEGER NOT NULL,
  name TEXT NOT NULL,
  reg_type TEXT NOT NULL CHECK(reg_type IN ('return', 'open')),
  status TEXT NOT NULL DEFAULT 'setup' CHECK(status IN ('setup', 'registration', 'purchasing', 'payment', 'complete')),
  -- Badge prices (cents to avoid float issues)
  price_preview_adult INTEGER NOT NULL DEFAULT 0,
  price_thu_adult INTEGER NOT NULL DEFAULT 0,
  price_fri_adult INTEGER NOT NULL DEFAULT 0,
  price_sat_adult INTEGER NOT NULL DEFAULT 0,
  price_sun_adult INTEGER NOT NULL DEFAULT 0,
  price_preview_junior INTEGER NOT NULL DEFAULT 0,
  price_thu_junior INTEGER NOT NULL DEFAULT 0,
  price_fri_junior INTEGER NOT NULL DEFAULT 0,
  price_sat_junior INTEGER NOT NULL DEFAULT 0,
  price_sun_junior INTEGER NOT NULL DEFAULT 0,
  access_token TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS participants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  -- Identity
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  member_id TEXT NOT NULL DEFAULT '',
  badge_type TEXT NOT NULL DEFAULT 'ADULT' CHECK(badge_type IN ('ADULT', 'JUNIOR')),
  return_eligible INTEGER NOT NULL DEFAULT 0, -- boolean
  sponsor TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  -- Requested days
  req_preview INTEGER NOT NULL DEFAULT 0,
  req_thu INTEGER NOT NULL DEFAULT 0,
  req_fri INTEGER NOT NULL DEFAULT 0,
  req_sat INTEGER NOT NULL DEFAULT 0,
  req_sun INTEGER NOT NULL DEFAULT 0,
  -- Sort order (lower = higher priority)
  sort_order INTEGER NOT NULL DEFAULT 9999,
  -- Coordinator assignment
  purchasing_coordinator TEXT NOT NULL DEFAULT '',
  -- Purchasing status
  purchasing_claimed_by TEXT NOT NULL DEFAULT '',
  purchasing_claimed_at TEXT,
  -- Purchased days
  pur_preview INTEGER NOT NULL DEFAULT 0,
  pur_thu INTEGER NOT NULL DEFAULT 0,
  pur_fri INTEGER NOT NULL DEFAULT 0,
  pur_sat INTEGER NOT NULL DEFAULT 0,
  pur_sun INTEGER NOT NULL DEFAULT 0,
  who_purchased TEXT NOT NULL DEFAULT '',
  -- Payment
  paid INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS coordinators (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  venmo TEXT NOT NULL DEFAULT '',
  zelle TEXT NOT NULL DEFAULT '',
  paypal TEXT NOT NULL DEFAULT '',
  phone_last4 TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Index for fast live board queries
CREATE INDEX IF NOT EXISTS idx_participants_event_sort ON participants(event_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_coordinators_event ON coordinators(event_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_coordinators_event_name ON coordinators(event_id, name);
