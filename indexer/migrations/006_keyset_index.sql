-- Migration 006: Keyset pagination index for GET /api/events
--
-- Closes #490 — /api/events now paginates by seq (keyset) instead of OFFSET.
--
-- `seq` is the BIGSERIAL PRIMARY KEY (see 002_core_schema.sql), so a plain
-- btree on seq already exists. This composite index additionally covers the
-- common filtered scan — `WHERE contract_id = $1 AND seq < $2 ORDER BY seq
-- DESC LIMIT N` — letting the planner walk seq in descending order and check
-- contract_id from the index without heap fetches.
--
-- Idempotent (IF NOT EXISTS) so the migration is safe to re-run.
CREATE INDEX IF NOT EXISTS idx_events_seq_desc_contract_id
  ON events (seq DESC, contract_id);
