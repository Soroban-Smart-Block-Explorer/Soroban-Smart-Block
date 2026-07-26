-- Migration 012: add is_verified and verified_at to contracts
-- is_verified is set to TRUE by the background verification job when the
-- functions hash stored in this DB matches the on-chain ContractMeta.
-- verified_ledger records the ledger at which verification was last confirmed.

ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS is_verified      BOOLEAN      NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS verified_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS verified_ledger  INT;

CREATE INDEX IF NOT EXISTS idx_contracts_is_verified
  ON contracts (is_verified)
  WHERE is_verified = TRUE;
