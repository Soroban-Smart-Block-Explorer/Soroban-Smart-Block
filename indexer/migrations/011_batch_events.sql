-- Migration 011: Add batch_description column to events (Batch Decoder feature)
-- Stores the aggregate description when multiple events share the same tx_hash.

ALTER TABLE events ADD COLUMN IF NOT EXISTS batch_description TEXT;

-- Index for querying events that are part of a batch
CREATE INDEX IF NOT EXISTS idx_events_batch_tx ON events(tx_hash) WHERE batch_description IS NOT NULL;
