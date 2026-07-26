-- Migration 010: NFT support
-- Adds protocol_type to contracts table and NFT-specific columns to token_holders.

-- Mark a contract as an NFT collection so the UI can route to /nft/:id
ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS protocol_type TEXT;

CREATE INDEX IF NOT EXISTS idx_contracts_protocol_type
  ON contracts(protocol_type)
  WHERE protocol_type IS NOT NULL;

-- Add NFT-specific columns to token_holders.
-- For NFT collections each row represents one minted token (token_id is non-null).
-- For fungible tokens these columns remain NULL and the table is used exactly as before.
ALTER TABLE token_holders
  ADD COLUMN IF NOT EXISTS token_id           TEXT,
  ADD COLUMN IF NOT EXISTS metadata_json      JSONB,
  ADD COLUMN IF NOT EXISTS last_transfer_ledger BIGINT;

-- Index to quickly look up all tokens in a collection and sort by token_id
CREATE INDEX IF NOT EXISTS idx_token_holders_nft
  ON token_holders(contract_id, token_id)
  WHERE token_id IS NOT NULL;
