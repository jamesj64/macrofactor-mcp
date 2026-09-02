-- Upgrade an EXISTING database created from the upstream (chaotix345) schema.
-- Fresh installs don't need this: schema.sql already includes the columns.
--   npx wrangler d1 execute macrofactor --file=./migrations/0001_claims.sql --remote
ALTER TABLE pending_food   ADD COLUMN claimed_at INTEGER;
ALTER TABLE pending_water  ADD COLUMN claimed_at INTEGER;
ALTER TABLE pending_weight ADD COLUMN claimed_at INTEGER;
