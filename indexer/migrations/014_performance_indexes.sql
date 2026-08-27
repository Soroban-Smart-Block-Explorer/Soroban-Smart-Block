-- Migration 005: Performance indexes for events pagination and contract history
--
-- Closes #423 — index supporting GET /api/events cursor pagination.
-- Closes #424 — index supporting GET /api/wallet/:address and
--               GET /api/contracts/:id/events contract-history lookups.
--
-- NOTE ON COLUMN NAMING:
--   Issues #423/#424 refer to a column `events.ledger_sequence`. In this
--   schema (see 002_core_schema.sql) the ledger-sequence value is stored in
--   the column `events.ledger`. The indexes below target the real column so
--   the migration applies cleanly on a fresh database (see #425).
--
-- All statements are idempotent (IF NOT EXISTS) so the migration is safe to
-- re-run and never conflicts with indexes created by earlier migrations.

-- #423 — pagination cursor on ledger sequence.
-- GET /api/events orders by ledger DESC; a descending index lets the planner
-- satisfy `ORDER BY ledger DESC LIMIT N` with a forward index scan instead of
-- a full table scan + sort as the events table grows.
CREATE INDEX IF NOT EXISTS idx_events_ledger_sequence
  ON events (ledger DESC);

-- #424 — contract history lookup.
-- GET /api/wallet/:address and GET /api/contracts/:id/events filter by
-- contract_id; this index turns those sequential scans into index scans.
CREATE INDEX IF NOT EXISTS idx_events_contract_id
  ON events (contract_id);
