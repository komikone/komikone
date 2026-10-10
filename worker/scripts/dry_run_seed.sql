-- Practice roster for the dry-run event (id 12).
-- Tagged with the standard [DUMMY] markers so the admin "clear dummies" tooling removes
-- them cleanly. Scoped to event 12 only so event 2's real roster is untouched.

INSERT INTO groups (event_id, name, color, sort_order) VALUES
  (12, '[DUMMY] Hall H Crew',   '#6366f1', 1),
  (12, '[DUMMY] Exhibit Hall',  '#ec4899', 2),
  (12, '[DUMMY] Artists Alley', '#14b8a6', 3);

INSERT INTO participants
  (event_id, first_name, last_name, member_id, badge_type, return_eligible, notes,
   req_preview, req_thu, req_fri, req_sat, req_sun, sort_order, group_id)
VALUES
  (12, 'Riley',   'Patel',    'DUMMY-1001', 'ADULT',  1, '[DUMMY]', 1, 1, 1, 1, 1,  1, (SELECT id FROM groups WHERE event_id=12 AND name='[DUMMY] Hall H Crew')),
  (12, 'Avery',   'Smith',    'DUMMY-1002', 'ADULT',  1, '[DUMMY]', 0, 1, 1, 1, 0,  2, (SELECT id FROM groups WHERE event_id=12 AND name='[DUMMY] Hall H Crew')),
  (12, 'Jordan',  'Kim',      'DUMMY-1003', 'ADULT',  1, '[DUMMY]', 0, 0, 1, 1, 0,  3, (SELECT id FROM groups WHERE event_id=12 AND name='[DUMMY] Hall H Crew')),
  (12, 'Casey',   'Nguyen',   'DUMMY-1004', 'JUNIOR', 1, '[DUMMY]', 0, 0, 0, 1, 0,  4, (SELECT id FROM groups WHERE event_id=12 AND name='[DUMMY] Hall H Crew')),
  (12, 'Morgan',  'Diaz',     'DUMMY-1005', 'ADULT',  1, '[DUMMY]', 1, 1, 1, 1, 1,  5, (SELECT id FROM groups WHERE event_id=12 AND name='[DUMMY] Exhibit Hall')),
  (12, 'Taylor',  'Brooks',   'DUMMY-1006', 'ADULT',  1, '[DUMMY]', 0, 1, 0, 1, 1,  6, (SELECT id FROM groups WHERE event_id=12 AND name='[DUMMY] Exhibit Hall')),
  (12, 'Quinn',   'Alvarez',  'DUMMY-1007', 'ADULT',  1, '[DUMMY]', 0, 0, 1, 1, 1,  7, (SELECT id FROM groups WHERE event_id=12 AND name='[DUMMY] Exhibit Hall')),
  (12, 'Reese',   'Okafor',   'DUMMY-1008', 'JUNIOR', 1, '[DUMMY]', 0, 0, 0, 1, 1,  8, (SELECT id FROM groups WHERE event_id=12 AND name='[DUMMY] Exhibit Hall')),
  (12, 'Sam',     'Lindqvist','DUMMY-1009', 'ADULT',  1, '[DUMMY]', 1, 1, 1, 1, 0,  9, (SELECT id FROM groups WHERE event_id=12 AND name='[DUMMY] Artists Alley')),
  (12, 'Harper',  'Mori',     'DUMMY-1010', 'ADULT',  1, '[DUMMY]', 0, 1, 1, 0, 0, 10, (SELECT id FROM groups WHERE event_id=12 AND name='[DUMMY] Artists Alley')),
  (12, 'Rowan',   'Silva',    'DUMMY-1011', 'ADULT',  1, '[DUMMY]', 0, 0, 1, 1, 0, 11, (SELECT id FROM groups WHERE event_id=12 AND name='[DUMMY] Artists Alley')),
  (12, 'Emerson', 'Clarke',   'DUMMY-1012', 'ADULT',  1, '[DUMMY]', 1, 0, 0, 1, 1, 12, (SELECT id FROM groups WHERE event_id=12 AND name='[DUMMY] Artists Alley')),
  (12, 'Finley',  'Ward',     'DUMMY-1013', 'ADULT',  1, '[DUMMY]', 0, 1, 1, 1, 0, 13, NULL),
  (12, 'Sage',    'Romero',   'DUMMY-1014', 'ADULT',  1, '[DUMMY]', 0, 0, 0, 1, 0, 14, NULL),
  (12, 'Drew',    'Bennett',  'DUMMY-1015', 'JUNIOR', 1, '[DUMMY]', 0, 1, 1, 1, 1, 15, NULL),
  (12, 'Skyler',  'Hayes',    'DUMMY-1016', 'ADULT',  1, '[DUMMY]', 1, 1, 0, 0, 0, 16, NULL),
  (12, 'Parker',  'Osei',     'DUMMY-1017', 'ADULT',  1, '[DUMMY]', 0, 0, 1, 1, 1, 17, NULL),
  (12, 'Marlow',  'Fitz',     'DUMMY-1018', 'ADULT',  1, '[DUMMY]', 0, 1, 1, 1, 0, 18, NULL);
