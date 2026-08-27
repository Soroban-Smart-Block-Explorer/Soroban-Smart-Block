-- Migration 026: Enforce event de-duplication at the database level (#587)
--
-- upsertEvent() relied on a bare `ON CONFLICT DO NOTHING` with no matching
-- unique constraint, so it never actually deduplicated — concurrent inserts
-- of the same event (same contract_id, ledger, tx_hash) could each succeed
-- and produce multiple rows. Remove any duplicates already present, then add
-- the unique index so `ON CONFLICT (contract_id, ledger, tx_hash)` has a
-- constraint to target.

DELETE FROM events a USING events b
WHERE a.seq < b.seq
  AND a.contract_id = b.contract_id
  AND a.ledger = b.ledger
  AND a.tx_hash IS NOT DISTINCT FROM b.tx_hash;

CREATE UNIQUE INDEX IF NOT EXISTS idx_events_dedup
  ON events (contract_id, ledger, tx_hash);
