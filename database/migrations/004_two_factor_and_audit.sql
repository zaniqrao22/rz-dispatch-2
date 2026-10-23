-- 004_two_factor_and_audit.sql
-- Two-factor authentication (TOTP) columns and the platform audit trail.
-- Idempotent: safe to run repeatedly. Applied automatically on the first
-- database access via server.js `initializeDatabase`, and also by
-- `npm run db:migrate` (scripts/migrate.js splits statements on semicolons,
-- so avoid literal semicolons inside comments and string literals).

ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT;

ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled INTEGER NOT NULL DEFAULT 0;

ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_backup_codes TEXT;

ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_confirmed_at TEXT;

CREATE TABLE IF NOT EXISTS platform_activity (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT,
  actor_email TEXT,
  actor_role TEXT,
  action TEXT NOT NULL,
  target TEXT,
  method TEXT,
  path TEXT,
  ip TEXT,
  status TEXT,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_platform_activity_created ON platform_activity (created_at DESC);
