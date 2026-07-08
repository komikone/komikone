-- Backfill year_members from existing participants with Clerk accounts.
-- Non-destructive: INSERT OR IGNORE skips rows that already exist.

INSERT OR IGNORE INTO year_members (
  year_id, clerk_user_id, role, first_name, last_name, member_id, badge_type, return_eligible
)
SELECT
  y.id,
  p.clerk_user_id,
  'registered',
  p.first_name,
  p.last_name,
  p.member_id,
  p.badge_type,
  p.return_eligible
FROM participants p
JOIN events e ON e.id = p.event_id
JOIN years y ON y.con_year = e.year
WHERE p.clerk_user_id IS NOT NULL
  AND p.clerk_user_id != ''
  AND p.id = (
    SELECT p2.id
    FROM participants p2
    JOIN events e2 ON e2.id = p2.event_id
    WHERE e2.year = e.year
      AND p2.clerk_user_id = p.clerk_user_id
    ORDER BY CASE WHEN e2.reg_type = 'return' THEN 0 ELSE 1 END, p2.id
    LIMIT 1
  );
