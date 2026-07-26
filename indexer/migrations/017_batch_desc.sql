-- Migration 017: add batch_description column for multi-event transactions (issue #564)
--
-- When multiple events share the same tx_hash the batch decoder groups them and
-- writes a combined human-readable summary into the first event's
-- batch_description column.  All other events in the batch leave this column
-- NULL so that single-event transactions are unaffected.

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS batch_description TEXT DEFAULT NULL;

-- Index to quickly locate all events in a batch by tx_hash.
CREATE INDEX IF NOT EXISTS idx_events_tx_hash ON events (tx_hash);
