-- Admin approval workflow: add the `status` column to the users table.
-- New registrations default to 'pending' and must be approved by an admin
-- before they can sign in. Existing accounts (pre-approval users) are
-- backfilled to 'approved' so upgrading never locks out current users.
ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending';
UPDATE users SET status = 'approved' WHERE status = 'pending';