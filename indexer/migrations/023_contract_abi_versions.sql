-- Migration 010: contract_abi_versions table
-- Persists each ABI version snapshot for a contract so the history endpoint
-- can return every version that was ever registered (v0, v1, v2, …).
-- Populated when an update_contract event is detected by the decoder.

CREATE TABLE IF NOT EXISTS contract_abi_versions (
  id           BIGSERIAL      PRIMARY KEY,
  contract_id  TEXT           NOT NULL,
  abi_version  INT            NOT NULL,
  functions    JSONB          NOT NULL DEFAULT '[]',
  registered_by TEXT          NOT NULL DEFAULT '',
  min_ledger   INT            NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  UNIQUE (contract_id, abi_version)
);

CREATE INDEX IF NOT EXISTS idx_contract_abi_versions_contract
  ON contract_abi_versions (contract_id, abi_version ASC);
