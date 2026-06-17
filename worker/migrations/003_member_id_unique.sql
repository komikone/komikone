-- Delete duplicate member_ids per event, keeping the earliest row (min id)
DELETE FROM participants
WHERE member_id != ''
  AND id NOT IN (
    SELECT MIN(id)
    FROM participants
    WHERE member_id != ''
    GROUP BY event_id, UPPER(member_id)
  );

-- Partial unique index: enforces uniqueness only for non-empty member_ids
CREATE UNIQUE INDEX IF NOT EXISTS idx_participants_event_member_id
ON participants(event_id, UPPER(member_id))
WHERE member_id != '';
