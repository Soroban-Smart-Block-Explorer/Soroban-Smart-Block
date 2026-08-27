-- Support data needed by the contract detail page widgets:
--   * WASM build metadata panel (#537) — contract size in bytes
--   * Circuit breaker status widget (#539) — which event tripped the breaker

ALTER TABLE wasm_build_metadata
  ADD COLUMN IF NOT EXISTS size_bytes BIGINT;

ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS pause_trigger_tx_hash TEXT,
  ADD COLUMN IF NOT EXISTS pause_trigger_event_seq BIGINT;
