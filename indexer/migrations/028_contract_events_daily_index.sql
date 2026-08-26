-- Closes #799 — GET /api/contracts/:id/stats?range=90|365 needs an efficient
-- (contract_id, created_at) range scan to build the daily event-volume series
-- for long historical windows. Without it, Postgres re-scans every event for a
-- contract once per generated day (up to 365 index probes per request).
CREATE INDEX IF NOT EXISTS idx_events_contract_created
  ON events (contract_id, created_at);
