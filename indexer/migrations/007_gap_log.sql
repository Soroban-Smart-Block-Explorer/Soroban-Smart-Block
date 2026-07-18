-- Migration 007: Gap detection and remediation tracking

-- Log of every detected ledger gap (open or closed)
CREATE TABLE IF NOT EXISTS gap_log (
  id            BIGSERIAL PRIMARY KEY,
  from_ledger   BIGINT NOT NULL,
  to_ledger     BIGINT NOT NULL,
  size          INT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open',  -- open | closed | dlq
  retries       INT NOT NULL DEFAULT 0,
  closed_at     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gap_log_status ON gap_log(status);
CREATE INDEX IF NOT EXISTS idx_gap_log_from   ON gap_log(from_ledger);
CREATE INDEX IF NOT EXISTS idx_gap_log_created ON gap_log(created_at);
