-- Per-ledger Soroban network config limits (#921), recorded on config upgrades.
CREATE TABLE IF NOT EXISTS ledger_config_settings (
  ledger BIGINT PRIMARY KEY,
  limits JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
