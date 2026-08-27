-- Migration: Create sandboxes table
-- This table stores user sandboxes with their files and metadata

CREATE TABLE IF NOT EXISTS sandboxes (
  sandbox_id VARCHAR(32) PRIMARY KEY,
  template_id VARCHAR(50) NOT NULL,
  files JSONB NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sandboxes_created_at ON sandboxes (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sandboxes_template ON sandboxes (template_id);

-- Add trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sandboxes_update_timestamp
BEFORE UPDATE ON sandboxes
FOR EACH ROW
EXECUTE FUNCTION update_updated_at();
