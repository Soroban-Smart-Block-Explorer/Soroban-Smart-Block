-- Issue #523: contract ownership — track which API key registered a contract
-- so that PATCH /api/contracts/:id can enforce ownership.

ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS registered_by_key_id INT REFERENCES api_keys(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_contracts_registered_by_key
  ON contracts (registered_by_key_id)
  WHERE registered_by_key_id IS NOT NULL;
