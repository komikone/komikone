-- Give existing year-5 members a group and a linked row in the drill event, so they land
-- straight on the board instead of the "link your identity" modal. New friends get this
-- automatically when they accept an invite, since accept creates rows in every year-5 event.

INSERT INTO groups (event_id, name, color, owner_clerk_user_id)
SELECT 12, ym.first_name || '''s Group', '#6366f1', ym.clerk_user_id
FROM year_members ym
WHERE ym.year_id = 5
  AND ym.clerk_user_id != ''
  AND NOT EXISTS (
    SELECT 1 FROM groups g WHERE g.event_id = 12 AND g.owner_clerk_user_id = ym.clerk_user_id
  );

INSERT INTO participants
  (event_id, first_name, last_name, member_id, badge_type, return_eligible,
   clerk_user_id, registered_by_clerk_user_id, group_id,
   req_preview, req_thu, req_fri, req_sat, req_sun, sort_order)
SELECT
  12, ym.first_name, ym.last_name, ym.member_id, ym.badge_type, ym.return_eligible,
  ym.clerk_user_id, ym.clerk_user_id,
  (SELECT id FROM groups WHERE event_id = 12 AND owner_clerk_user_id = ym.clerk_user_id),
  0, 1, 1, 1, 0, 100
FROM year_members ym
WHERE ym.year_id = 5
  AND ym.clerk_user_id != ''
  AND NOT EXISTS (
    SELECT 1 FROM participants p WHERE p.event_id = 12 AND p.clerk_user_id = ym.clerk_user_id
  );
