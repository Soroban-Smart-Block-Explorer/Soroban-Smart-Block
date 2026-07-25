-- Migration 010: Add is_failed and failure_reason columns to events (#566)
-- Stores failure information from failed transactions alongside the event.

ALTER TABLE events ADD COLUMN IF NOT EXISTS is_failed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE events ADD COLUMN IF NOT EXISTS failure_reason TEXT;

-- Index for filtering failed events via ?failed=true
CREATE INDEX IF NOT EXISTS idx_events_is_failed ON events(is_failed) WHERE is_failed = TRUE;
