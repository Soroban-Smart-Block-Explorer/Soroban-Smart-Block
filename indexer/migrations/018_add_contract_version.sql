-- Migration 005: Add ABI version field to contract metadata

ALTER TABLE contracts
ADD COLUMN version INT NOT NULL DEFAULT 1;

-- Create index for version-based queries if needed
CREATE INDEX IF NOT EXISTS idx_contracts_version ON contracts(version);
