-- Password recovery and per-device sessions (see src/worker.js, src/lib/auth.js).
ALTER TABLE sessions ADD COLUMN device TEXT;
ALTER TABLE sessions ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN last_seen INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS recovery_codes (user_id INTEGER PRIMARY KEY, code_hash TEXT NOT NULL, created_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
