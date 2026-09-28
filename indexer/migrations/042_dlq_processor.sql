-- Migration 042 (issue #851): DLQ processor state, error classification,
-- poison detection and quarantine. first-seen = created_at, attempts = retry_count.

ALTER TABLE dead_letter_queue ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'queued'; -- queued | retrying | quarantined | resolved
ALTER TABLE dead_letter_queue ADD COLUMN IF NOT EXISTS error_class TEXT;
ALTER TABLE dead_letter_queue ADD COLUMN IF NOT EXISTS stack_hash TEXT;
ALTER TABLE dead_letter_queue ADD COLUMN IF NOT EXISTS resolved_reason TEXT;

UPDATE dead_letter_queue SET state = 'resolved' WHERE resolved = TRUE AND state <> 'resolved';

CREATE INDEX IF NOT EXISTS idx_dlq_state_next_retry ON dead_letter_queue(state, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_dlq_stack_hash ON dead_letter_queue(stack_hash) WHERE state <> 'resolved';
CREATE INDEX IF NOT EXISTS idx_dlq_error_class ON dead_letter_queue(error_class);
