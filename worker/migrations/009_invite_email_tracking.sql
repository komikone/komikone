-- Track Clerk invitation emails for resend/revoke
ALTER TABLE invites ADD COLUMN invited_email TEXT;
ALTER TABLE invites ADD COLUMN clerk_invitation_id TEXT;
