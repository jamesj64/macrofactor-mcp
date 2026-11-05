-- Only a hash of a random 256-bit, short-lived setup code is stored.
-- Provision via authorized administration, never via a public issuance endpoint.
-- Times are Unix milliseconds; the database enforces a maximum ten-minute life.
CREATE TABLE IF NOT EXISTS gmail_oauth_setup_codes (
  code_hash TEXT PRIMARY KEY CHECK(length(code_hash) = 43),
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  CHECK(expires_at > issued_at AND expires_at - issued_at <= 600000)
);
