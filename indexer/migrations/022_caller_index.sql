-- Migration 010: Caller address column + composite index for contract stats
--
-- Closes #541 — GET /api/contracts/:id/stats needs COUNT(DISTINCT caller_address)
-- to report unique callers per contract.
--
-- NOTE ON MIGRATION NUMBERING:
--   Issue #541 refers to this file as `014_caller_index.sql`. The highest
--   migration actually present in this directory at the time of writing is
--   009 (see 009_abi_version_tracking.sql), so the next sequential file is
--   010. Using 010 keeps the filename-ordered migration runner (src/migrate.js)
--   gapless; a 014 would silently skip 010-013.
--
-- NOTE ON caller_address:
--   `events` (see 002_core_schema.sql) has no caller_address column — the
--   ingestion pipeline does not currently capture the invoking account. This
--   migration adds the column so the stats query has somewhere to read from;
--   populating it from transaction source accounts is a follow-up to the
--   ingestion pipeline, out of scope for this endpoint. Until then the column
--   is NULL for existing/new rows and unique_callers reports 0.
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS caller_address TEXT;

CREATE INDEX IF NOT EXISTS idx_events_contract_caller
  ON events(contract_id, caller_address);
