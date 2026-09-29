-- Migration 044 (issue #796): reproducible-build source verification.

-- Latest on-chain WASM hash per contract, refreshed by the verifier (RPC) and
-- by the indexer whenever an upgrade event is observed.
CREATE TABLE IF NOT EXISTS contract_code_state (
  contract_id  TEXT PRIMARY KEY,
  wasm_hash    TEXT NOT NULL,
  ledger       BIGINT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per verification request. built_hash / onchain_hash are only ever
-- written by the verifier itself, never taken from the requester.
CREATE TABLE IF NOT EXISTS contract_code_verifications (
  id                 BIGSERIAL PRIMARY KEY,
  contract_id        TEXT NOT NULL,
  source_repo        TEXT NOT NULL,
  source_commit      TEXT NOT NULL,
  toolchain          JSONB NOT NULL DEFAULT '{}'::JSONB,
  status             TEXT NOT NULL DEFAULT 'pending', -- pending | building | completed | failed
  reason             TEXT,
  onchain_hash       TEXT,
  built_hash         TEXT,
  reproducible       BOOLEAN,
  source_retrievable BOOLEAN NOT NULL DEFAULT TRUE,
  build_log          TEXT,
  requested_by       TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_code_verifications_contract ON contract_code_verifications(contract_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_code_verifications_status ON contract_code_verifications(status) WHERE status IN ('pending', 'building');
