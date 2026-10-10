-- Dry-run drill event for the Oct 17 Return Registration rehearsal.
--
-- Deliberately reg_type='open' rather than 'return': a return board hides anyone whose
-- year_member row has return_eligible off, and the join form defaults that toggle off.
-- For a rehearsal that would silently lock people out of the board instead of letting
-- them practice. Eligibility is audited separately against the real event.
--
-- Lives under year 5 so one invite covers both this drill and the real Oct 17 event.

INSERT INTO events (
  year, year_id, name, reg_type, status,
  price_preview_adult, price_thu_adult, price_fri_adult, price_sat_adult, price_sun_adult,
  price_preview_junior, price_thu_junior, price_fri_junior, price_sat_junior, price_sun_junior
) VALUES (
  2027, 5, 'DRY RUN — Practice Purchase Day', 'open', 'purchasing',
  6500, 8500, 8500, 8500, 5500,
  3500, 4500, 4500, 4500, 3000
);
