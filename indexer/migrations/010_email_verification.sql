-- Migration 010: Email verification for self-service API key creation

-- Add email verification fields to api_keys table
ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS email TEXT,
  ADD COLUMN IF NOT EXISTS verified BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS verification_token TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS verification_expires_at TIMESTAMPTZ;

-- Create index for verification token lookup
CREATE INDEX IF NOT EXISTS idx_api_keys_verification_token 
  ON api_keys (verification_token);

-- Create index for email lookup
CREATE INDEX IF NOT EXISTS idx_api_keys_email 
  ON api_keys (email);
