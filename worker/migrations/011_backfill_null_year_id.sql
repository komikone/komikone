-- Link any orphan events (year_id IS NULL) to the matching years row by con_year.
-- If no years row exists for that con_year, attach to the latest (current) year.
-- Then backfill year_members for Clerk-linked participants still missing a membership.

UPDATE events
SET year_id = (
  SELECT id FROM years WHERE years.con_year = events.year LIMIT 1
)
WHERE year_id IS NULL
  AND EXISTS (SELECT 1 FROM years WHERE years.con_year = events.year);

UPDATE events
SET year_id = (
  SELECT id FROM years ORDER BY con_year DESC LIMIT 1
),
year = (
  SELECT con_year FROM years ORDER BY con_year DESC LIMIT 1
)
WHERE year_id IS NULL
  AND EXISTS (SELECT 1 FROM years);

INSERT OR IGNORE INTO year_members (
  year_id, clerk_user_id, role, first_name, last_name, member_id, badge_type, return_eligible
)
SELECT
  COALESCE(e.year_id, y.id),
  p.clerk_user_id,
  'registered',
  p.first_name,
  p.last_name,
  p.member_id,
  p.badge_type,
  p.return_eligible
FROM participants p
JOIN events e ON e.id = p.event_id
LEFT JOIN years y ON y.con_year = e.year
WHERE p.clerk_user_id IS NOT NULL
  AND p.clerk_user_id != ''
  AND COALESCE(e.year_id, y.id) IS NOT NULL
  AND p.id = (
    SELECT p2.id
    FROM participants p2
    JOIN events e2 ON e2.id = p2.event_id
    WHERE e2.year = e.year
      AND p2.clerk_user_id = p.clerk_user_id
    ORDER BY CASE WHEN e2.reg_type = 'return' THEN 0 ELSE 1 END, p2.id
    LIMIT 1
  );
