INSERT INTO invites (year_id, code, label, invited_by_clerk_user_id) VALUES
  (5, 'RJHRKUCY5E56', 'Dry run #1', (SELECT clerk_user_id FROM year_members WHERE year_id=5 AND member_id='tonyn858')),
  (5, 'MKZJ5SA6AQ4T', 'Dry run #2', (SELECT clerk_user_id FROM year_members WHERE year_id=5 AND member_id='tonyn858')),
  (5, 'FQFFD2AWA5HQ', 'Dry run #3', (SELECT clerk_user_id FROM year_members WHERE year_id=5 AND member_id='tonyn858')),
  (5, '2N4JNFUWM7LG', 'Dry run #4', (SELECT clerk_user_id FROM year_members WHERE year_id=5 AND member_id='tonyn858')),
  (5, 'W6ELGYFXQ23E', 'Dry run #5', (SELECT clerk_user_id FROM year_members WHERE year_id=5 AND member_id='tonyn858')),
  (5, 'TJSBRUBQ9F3N', 'Dry run #6', (SELECT clerk_user_id FROM year_members WHERE year_id=5 AND member_id='tonyn858'));
