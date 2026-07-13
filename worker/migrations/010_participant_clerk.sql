-- Link participants to Clerk accounts (used by invite accept, identity, dashboard).
-- Safe to re-run: SQLite has no IF NOT EXISTS for ADD COLUMN; ignore duplicate-column errors.

ALTER TABLE participants ADD COLUMN clerk_user_id TEXT;
ALTER TABLE participants ADD COLUMN registered_by_clerk_user_id TEXT;

CREATE INDEX IF NOT EXISTS idx_participants_clerk ON participants(clerk_user_id);
CREATE INDEX IF NOT EXISTS idx_participants_registered_by ON participants(registered_by_clerk_user_id);
