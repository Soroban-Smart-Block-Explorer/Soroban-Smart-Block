-- Migration 007: Ledger gap log for predictive gap detection

CREATE TABLE IF NOT EXISTS gap_log (
  id          BIGSERIAL PRIMARY KEY,
  from_ledger BIGINT NOT NULL,
  to_ledger   BIGINT NOT NULL,
  size        INT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  closed_at   TIMESTAMPTZ,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gap_log_status    ON gap_log(status);
CREATE INDEX IF NOT EXISTS idx_gap_log_from      ON gap_log(from_ledger);
CREATE INDEX IF NOT EXISTS idx_gap_log_pending   ON gap_log(status) WHERE status = 'open';
