-- Migration 028: Guard token_holders creation idempotency
--
-- Closes #632, #633, #623, #620
--
-- The token_holders table is defined in 004_vaults_and_tokens.sql using
-- CREATE TABLE IF NOT EXISTS. This migration adds an explicit DO block to
-- ensure that any environment where the table was previously created outside
-- the migration system (e.g. via a legacy JS migration runner or a manual
-- schema dump) does not fail on re-apply.
--
-- Safe to run on both fresh and existing databases: the DO block is a no-op
-- when the table already exists.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name   = 'token_holders'
  ) THEN
    CREATE TABLE token_holders (
      id          BIGSERIAL PRIMARY KEY,
      contract_id TEXT NOT NULL,
      address     TEXT NOT NULL,
      balance_raw TEXT NOT NULL DEFAULT '0',
      updated_at  TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (contract_id, address)
    );

    CREATE INDEX idx_token_holders_contract ON token_holders(contract_id);
  END IF;
END;
$$;
