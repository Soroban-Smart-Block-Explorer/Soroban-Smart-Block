-- Migration 021: trigram indexes backing GET /api/search
--
-- searchContracts/searchEvents/searchWallets (see db.js) ILIKE '%term%'
-- against contracts.name, events.tx_hash, and events.function. A leading
-- wildcard defeats a plain btree index, so these need pg_trgm's GIN
-- (gin_trgm_ops) indexes instead — target: keep the combined search query
-- under 50ms.
--
-- CONCURRENTLY avoids locking these tables for writes while the index
-- builds (see migrate.js, which runs this file's statements outside a
-- transaction to support it). IF NOT EXISTS keeps a retry after a partial
-- failure safe.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contracts_name_trgm
  ON contracts USING gin (name gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_tx_hash_trgm
  ON events USING gin (tx_hash gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_function_trgm
  ON events USING gin (function gin_trgm_ops);
