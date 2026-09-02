-- Live-feed provenance columns (fresh installs get these from schema.sql).
--   npx wrangler d1 execute macrofactor --file=./migrations/0002_live_sources.sql --remote
ALTER TABLE days     ADD COLUMN source TEXT;
ALTER TABLE food_log ADD COLUMN source TEXT;
