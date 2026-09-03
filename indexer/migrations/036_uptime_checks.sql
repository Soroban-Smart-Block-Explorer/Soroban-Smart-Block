-- Closes #758 — public status page needs historical uptime data. Stores a
-- periodic snapshot of the /health result so /api/status/history can render
-- rolling uptime percentages (e.g. 30 days) without depending on an external
-- monitor.
CREATE TABLE IF NOT EXISTS uptime_checks (
  id BIGSERIAL PRIMARY KEY,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL,
  db_healthy BOOLEAN NOT NULL,
  cache_healthy BOOLEAN NOT NULL,
  indexer_healthy BOOLEAN NOT NULL,
  ledger_lag_seconds INTEGER
);

CREATE INDEX IF NOT EXISTS idx_uptime_checks_checked_at ON uptime_checks (checked_at);
