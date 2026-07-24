-- Track the ABI used to decode each event so superseded values can be repaired.

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS abi_version INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS needs_redecode BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_events_needs_redecode
  ON events(contract_id)
  WHERE needs_redecode = TRUE;
