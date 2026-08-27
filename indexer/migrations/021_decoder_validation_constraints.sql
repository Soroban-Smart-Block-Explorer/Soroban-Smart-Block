-- Migration 006: Decoder output schema validation with corruption guards

-- Add `decoded` boolean flag to mark events that passed validation
ALTER TABLE events
ADD COLUMN decoded BOOLEAN NOT NULL DEFAULT TRUE;

-- Create index for querying unvalidated events
CREATE INDEX IF NOT EXISTS idx_events_decoded ON events(decoded);

-- Add NOT NULL and length constraint to description field (corruption guard)
-- This ensures decoded_text cannot be corrupted with null values or exceed 2048 chars
ALTER TABLE events
ADD CONSTRAINT check_description_not_empty CHECK (length(description) > 0);

ALTER TABLE events
ADD CONSTRAINT check_description_max_length CHECK (length(description) <= 2048);

-- Composite index for filtering and sorting by validation status and ledger
CREATE INDEX IF NOT EXISTS idx_events_decoded_ledger ON events(decoded, ledger DESC);

-- Create a view to quickly identify problematic events with invalid decoded_text
CREATE OR REPLACE VIEW events_with_validation_issues AS
SELECT
  seq,
  contract_id,
  function,
  ledger,
  tx_hash,
  description,
  decoded,
  created_at,
  CASE
    WHEN decoded = FALSE THEN 'validation_failed'
    WHEN description LIKE '%<invalid decoded text>%' THEN 'recovered_from_corruption'
    WHEN description LIKE '%[object Object]%' THEN 'object_tostring_corruption'
    WHEN description LIKE '%undefined%' THEN 'undefined_corruption'
    ELSE 'unknown_issue'
  END as issue_type
FROM events
WHERE decoded = FALSE OR description LIKE '%[object Object]%' 
   OR description LIKE '%undefined%'
   OR description LIKE '%<invalid decoded text>%';
