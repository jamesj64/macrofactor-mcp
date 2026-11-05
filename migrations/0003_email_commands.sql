CREATE TABLE IF NOT EXISTS food_command_requests (request_id TEXT PRIMARY KEY, manifest_hash TEXT NOT NULL);
-- Additive. Never migrates or deletes legacy pending_* data.
CREATE TABLE IF NOT EXISTS food_commands (
  id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, payload TEXT NOT NULL,
  payload_hash TEXT NOT NULL, created_at INTEGER NOT NULL, day TEXT NOT NULL,
  expires_at INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN
    ('ready','started','uncertain','confirmed','held','expired','cancelled')),
  validation TEXT NOT NULL, next_wake_at INTEGER NOT NULL, started_at INTEGER,
  confirmed_at INTEGER, receipt TEXT, last_error TEXT
);
CREATE INDEX IF NOT EXISTS food_commands_due ON food_commands(state, next_wake_at);
CREATE TABLE IF NOT EXISTS command_mail_attempts (
  id TEXT PRIMARY KEY, command_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN
    ('reserved','sending','sent','send_unknown','trashed')),
  created_at INTEGER NOT NULL, cleanup_at INTEGER NOT NULL, gmail_message_id TEXT,
  owner_account TEXT NOT NULL, next_check_at INTEGER NOT NULL DEFAULT 0, last_error TEXT
);
CREATE INDEX IF NOT EXISTS command_mail_cleanup ON command_mail_attempts(state, cleanup_at, next_check_at);
