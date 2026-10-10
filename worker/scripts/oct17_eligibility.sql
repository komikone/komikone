-- Rebuild the Oct 17 roster against the correct eligibility year.
--
-- SDCC's rule for the 2027 Returning Registration sale is "anyone who purchased a
-- Comic-Con 2026 attendee badge". The board was seeded from SDCC 2025 (year_id 3), which
-- missed 32 eligible people and carried 5 who are not eligible. The source of truth is a
-- *purchased* day in year_id 4, not a requested one -- requesting a badge you never got
-- does not make you a returning attendee.

-- ── 1. Drop the five with no 2026 badge ──────────────────────────────────────
-- Verified absent from year_id 4 entirely, not just unmatched on a malformed Member ID.
-- Their unused invites go too, so a dead link cannot be sent by mistake.

DELETE FROM invites
WHERE year_id = 5 AND used_at IS NULL
  AND label IN ('Christophe Velazquez', 'Karl Huang', 'Timmy Nguyen', 'Tyler Tharp', 'Wolfgang Wedemeyer');

DELETE FROM participants
WHERE event_id = 2
  AND UPPER(member_id) IN ('CHRISTOPHE VELAZQUEZ', 'HUANGKA97', 'TIMOTHYWEN', 'TYLIE', 'OKWOLF');

-- ── 2. Add every 2026 badge buyer who is not on the board ────────────────────
-- Identity only, no days: a guessed requested-day is indistinguishable from a confirmed
-- one on the board and gets a real badge bought against it.

INSERT INTO participants (
  event_id, first_name, last_name, member_id, badge_type, return_eligible, email
)
SELECT 2, elig.fn, elig.ln, elig.mid, elig.bt, 1, ''
FROM (
  SELECT UPPER(p.member_id) AS mid,
         MAX(p.first_name) AS fn, MAX(p.last_name) AS ln, MAX(p.badge_type) AS bt
  FROM participants p
  JOIN events e ON e.id = p.event_id
  WHERE e.year_id = 4
    AND p.member_id != ''
    AND (p.pur_preview + p.pur_thu + p.pur_fri + p.pur_sat + p.pur_sun) > 0
  GROUP BY UPPER(p.member_id)
) AS elig
WHERE elig.mid NOT IN (
  SELECT UPPER(member_id) FROM participants WHERE event_id = 2 AND member_id != ''
);

-- ── 3. Derive return eligibility from the 2026 purchase record ───────────────
-- Everyone was flagged eligible by default when the board was seeded. Anyone without a
-- 2026 badge is blocked by SDCC regardless of what this row says, so make the board agree.

UPDATE participants
SET return_eligible = CASE
  WHEN member_id != '' AND UPPER(member_id) IN (
    SELECT UPPER(p.member_id) FROM participants p
    JOIN events e ON e.id = p.event_id
    WHERE e.year_id = 4 AND p.member_id != ''
      AND (p.pur_preview + p.pur_thu + p.pur_fri + p.pur_sat + p.pur_sun) > 0
  ) THEN 1 ELSE 0 END
WHERE event_id = 2;
