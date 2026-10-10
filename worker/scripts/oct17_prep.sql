-- Oct 17 prep for event 2 (SDCC 2027 Return Reg).
--
-- Two jobs: strip the rehearsal rows that leaked into the real event, then seed the roster
-- from last year's return reg so the board is complete even for people who never sign in.
--
-- Days are deliberately NOT copied. On the board a guessed requested-day is indistinguishable
-- from a confirmed one and gets a real badge bought against it, whereas a blank one surfaces
-- as "No badge days requested" and refuses the claim. Missing data is recoverable; wrong data
-- is not.

-- ── 1. Remove dry-run residue ────────────────────────────────────────────────
-- purchase_queue references participants ON DELETE CASCADE, so queue rows go with them.

DELETE FROM participants WHERE event_id = 2 AND member_id LIKE 'DUMMY-%';
DELETE FROM participants WHERE event_id = 2 AND UPPER(member_id) = 'TESTN858';
DELETE FROM groups WHERE event_id = 2 AND (name LIKE '[DUMMY]%' OR name = 'Test''s Group');

-- ── 2. Seed last year's return-reg roster ────────────────────────────────────
-- Identity only: no group, no account, no days. return_eligible mirrors last year (all 55
-- were eligible) and still needs auditing against SDCC's published list before purchase day.

INSERT INTO participants (
  event_id, first_name, last_name, member_id, badge_type, return_eligible, email
)
SELECT 2, p.first_name, p.last_name, UPPER(p.member_id), p.badge_type, 1, ''
FROM participants p
WHERE p.event_id = 10
  AND UPPER(p.member_id) NOT IN (
    SELECT UPPER(member_id) FROM participants WHERE event_id = 2 AND member_id != ''
  );
