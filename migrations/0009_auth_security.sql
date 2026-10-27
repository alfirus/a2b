-- Signup/login protections: email verification, TOTP two-factor logins and signup throttling.
-- Keep in sync with src/lib/schema.js (which creates the same tables/columns on first request).
ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN totp_secret TEXT;
ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS email_verifications (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, email TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS email_verifications_user ON email_verifications (user_id, created_at);
CREATE TABLE IF NOT EXISTS auth_challenges (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, purpose TEXT NOT NULL DEFAULT 'totp', secret TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS signup_attempts (ip TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS signup_attempts_ip ON signup_attempts (ip, at);
