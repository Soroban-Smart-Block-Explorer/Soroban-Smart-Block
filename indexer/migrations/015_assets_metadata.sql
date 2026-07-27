-- Migration 015: extend the classic asset metadata cache (migration 010) for
-- the token metadata registry endpoints (#550).
--
-- Adds:
--   decimals  — needed for the GET /api/assets response shape
--   id        — monotonic cursor for keyset pagination on GET /api/assets
CREATE SEQUENCE IF NOT EXISTS assets_id_seq;

ALTER TABLE assets ADD COLUMN IF NOT EXISTS decimals INTEGER NOT NULL DEFAULT 7;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS id BIGINT DEFAULT nextval('assets_id_seq');

ALTER SEQUENCE assets_id_seq OWNED BY assets.id;

-- Backfill any pre-existing rows that predate the id column.
UPDATE assets SET id = nextval('assets_id_seq') WHERE id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_id ON assets(id);
