-- Identity linking previously depended entirely on SDCC Member ID, so anyone added by a
-- group owner without one (family members, dependents) could never be matched to their
-- account and got a duplicate row when they eventually signed in. Email gives us a second
-- key that the person adding them actually knows.
ALTER TABLE participants ADD COLUMN email TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_participants_event_email
  ON participants(event_id, LOWER(email))
  WHERE email != '';

-- Seed from invites we already emailed, so existing accounts are matchable straight away.
UPDATE participants
SET email = (
  SELECT LOWER(i.invited_email) FROM invites i
  WHERE i.used_by_clerk_user_id = participants.clerk_user_id
    AND i.invited_email IS NOT NULL AND i.invited_email != ''
  LIMIT 1
)
WHERE email = ''
  AND clerk_user_id IS NOT NULL AND clerk_user_id != ''
  AND EXISTS (
    SELECT 1 FROM invites i
    WHERE i.used_by_clerk_user_id = participants.clerk_user_id
      AND i.invited_email IS NOT NULL AND i.invited_email != ''
  );
