-- 003_portal_auth.sql
-- Customer Portal authentication, multi-tenant RBAC and session management.
-- Idempotent: safe to run repeatedly. Applied automatically on the first
-- database access via server.js `initializeDatabase`, and also by
-- `npm run db:migrate` (scripts/migrate.js splits statements on semicolons,
-- so avoid literal semicolons inside comments and string literals).

CREATE TABLE IF NOT EXISTS company_accounts (
  id TEXT PRIMARY KEY,
  company_name TEXT NOT NULL,
  account_type TEXT NOT NULL DEFAULT 'shipper',
  contact_email TEXT,
  phone TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  refresh_token_hash TEXT NOT NULL,
  user_agent TEXT,
  ip TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS otp_codes (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'portal_login',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
  email TEXT PRIMARY KEY,
  failed_count INTEGER NOT NULL DEFAULT 0,
  first_failed_at TEXT NOT NULL,
  locked_until TEXT
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS company_account_id TEXT;

ALTER TABLE users ADD COLUMN IF NOT EXISTS company_role TEXT;

ALTER TABLE users ADD COLUMN IF NOT EXISTS account_status TEXT NOT NULL DEFAULT 'active';

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS company_account_id TEXT;

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS company_account_id TEXT;

ALTER TABLE quotes ADD COLUMN IF NOT EXISTS company_account_id TEXT;

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);

CREATE INDEX IF NOT EXISTS idx_otp_email ON otp_codes (email);

CREATE INDEX IF NOT EXISTS idx_users_company ON users (company_account_id);
