-- eta_minutes alone was "minutes left when someone tapped", which never counts down, so a
-- 30m reported at 7:00 ranked behind a 25m reported at 7:20 and places leapfrogged.
-- eta_at is the moment that place is expected through Queue-It; it is the sort key now.
ALTER TABLE purchase_queue ADD COLUMN eta_at TEXT;

-- A name the owner picks ("iPhone", "Laptop Chrome"). Stored rather than derived from join
-- order, which renumbered every other place whenever one was removed.
ALTER TABLE purchase_queue ADD COLUMN label TEXT NOT NULL DEFAULT '';

UPDATE purchase_queue
SET eta_at = datetime(updated_at, '+' || eta_minutes || ' minutes')
WHERE eta_minutes IS NOT NULL AND eta_at IS NULL;

UPDATE purchase_queue
SET label = 'Place ' || (
  SELECT COUNT(*) FROM purchase_queue q2
  WHERE q2.event_id = purchase_queue.event_id
    AND q2.clerk_user_id = purchase_queue.clerk_user_id
    AND q2.id <= purchase_queue.id
)
WHERE label = '';

-- Flipped during the sale when Comic-Con runs out of a day, so the board stops treating
-- that day as something left to buy.
ALTER TABLE events ADD COLUMN sold_out_preview INTEGER NOT NULL DEFAULT 0;
ALTER TABLE events ADD COLUMN sold_out_thu INTEGER NOT NULL DEFAULT 0;
ALTER TABLE events ADD COLUMN sold_out_fri INTEGER NOT NULL DEFAULT 0;
ALTER TABLE events ADD COLUMN sold_out_sat INTEGER NOT NULL DEFAULT 0;
ALTER TABLE events ADD COLUMN sold_out_sun INTEGER NOT NULL DEFAULT 0;
