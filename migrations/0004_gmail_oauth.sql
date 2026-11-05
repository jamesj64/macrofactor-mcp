-- One-use OAuth state with encrypted PKCE verifier. No tokens or codes in plaintext.
CREATE TABLE IF NOT EXISTS gmail_oauth_states (
  state_hash TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS gmail_oauth_states_expiry ON gmail_oauth_states(expires_at);
CREATE TABLE IF NOT EXISTS gmail_oauth_tokens (
  id TEXT PRIMARY KEY CHECK (id = 'primary'),
  sender TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
