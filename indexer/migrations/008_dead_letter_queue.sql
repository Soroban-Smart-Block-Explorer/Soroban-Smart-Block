-- Create dead_letter_queue table as part of the migration system
-- This moves the table creation from deadLetterQueue.js to the proper migration flow

CREATE TABLE IF NOT EXISTS dead_letter_queue (
  id            BIGSERIAL PRIMARY KEY,
  event_id      TEXT,
  contract_id   TEXT,
  ledger        BIGINT,
  tx_hash       TEXT,
  raw_event     JSONB NOT NULL,
  error_message TEXT NOT NULL,
  error_code    TEXT,
  retry_count   INT NOT NULL DEFAULT 0,
  max_retries   INT NOT NULL DEFAULT 3,
  next_retry_at TIMESTAMPTZ,
  resolved      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_dlq_resolved    ON dead_letter_queue(resolved);
CREATE INDEX IF NOT EXISTS idx_dlq_next_retry  ON dead_letter_queue(next_retry_at) WHERE resolved = FALSE;
CREATE INDEX IF NOT EXISTS idx_dlq_ledger      ON dead_letter_queue(ledger);
