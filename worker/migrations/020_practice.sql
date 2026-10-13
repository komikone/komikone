-- Practice: a shared copy of an event's board that anyone can join to rehearse purchase day.
-- practice_of points at the real event; the copy has no year_id, so year-wide queries skip it.
ALTER TABLE events ADD COLUMN practice_of INTEGER REFERENCES events(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_events_practice_of ON events(practice_of);

-- Each practice row remembers the real row it was copied from, so practice uses real buy lists.
ALTER TABLE participants ADD COLUMN practice_source_id INTEGER;
