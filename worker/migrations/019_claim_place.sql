-- Each claim belongs to one place in the Queue-It line; Comic-Con's limit of 3 is per place.
ALTER TABLE participants ADD COLUMN purchasing_claimed_queue_id INTEGER
  REFERENCES purchase_queue(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_participants_claim_place ON participants(purchasing_claimed_queue_id);
