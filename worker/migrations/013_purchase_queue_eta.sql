-- Estimated wait from Queue-It screen ("25 minutes", "more than an hour", etc.)
-- Active buyers sort soonest-first so the call can prep whoever is about to get through.
ALTER TABLE purchase_queue ADD COLUMN eta_minutes INTEGER;
