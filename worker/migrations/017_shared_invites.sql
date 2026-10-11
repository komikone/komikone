-- Shared invite links: one code that up to max_uses people can join with.
-- Ordinary invites stay single-use (max_uses = 1). used_at marks an invite as full, so
-- every existing "already used" check keeps working for both kinds.
ALTER TABLE invites ADD COLUMN max_uses INTEGER NOT NULL DEFAULT 1;
ALTER TABLE invites ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0;

UPDATE invites SET use_count = 1 WHERE used_at IS NOT NULL;
