-- Migration 011: Add NFT mint metadata columns to token_holders
--
-- Tracks when and by whom each NFT token was minted.
-- minted_by is the address that called the mint_nft function.
-- minted_ledger is the ledger sequence number at which the mint occurred.

ALTER TABLE token_holders
  ADD COLUMN IF NOT EXISTS minted_ledger BIGINT,
  ADD COLUMN IF NOT EXISTS minted_by     TEXT;

-- Index to speed up NFT collection queries that filter/order by mint metadata
CREATE INDEX IF NOT EXISTS idx_token_holders_nft_minted
  ON token_holders(contract_id, minted_ledger)
  WHERE token_id IS NOT NULL;
