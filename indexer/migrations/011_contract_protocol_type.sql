-- Migration 011: add protocol_type to contracts
-- Enables filtering the contract registry by protocol type (DEX, Lending, NFT, …).
-- The value is auto-set by the indexer based on function name heuristics and can
-- also be supplied explicitly when registering a contract via POST /api/contracts.

ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS protocol_type TEXT
    CHECK (protocol_type IN ('token','dex','lending','nft','bridge','other'))
    DEFAULT 'other';

CREATE INDEX IF NOT EXISTS idx_contracts_protocol_type
  ON contracts (protocol_type);
