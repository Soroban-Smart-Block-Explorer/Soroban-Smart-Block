-- Migration 031: multi-network support (testnet/mainnet/futurenet)
--
-- Adds network-awareness to the indexer schema, allowing per-network data isolation
-- while maintaining backward compatibility through a DEFAULT value of 'testnet'.
--
-- Design: each relevant table gets a `network` column (TEXT, DEFAULT 'testnet')
-- and composite indexes where appropriate (network + existing indexes).
--
-- Per-network indexer instances:
-- - Each network runs its own indexer process with NETWORK env var
-- - Separate RPC/Horizon URLs per network (via config overrides)
-- - Data naturally partitions by network column

-- Add network column to events table
ALTER TABLE events ADD COLUMN network TEXT NOT NULL DEFAULT 'testnet';

-- Create indexes for network-aware queries
CREATE INDEX IF NOT EXISTS idx_events_network ON events(network);
CREATE INDEX IF NOT EXISTS idx_events_network_contract ON events(network, contract_id);
CREATE INDEX IF NOT EXISTS idx_events_network_ledger ON events(network, ledger DESC);
CREATE INDEX IF NOT EXISTS idx_events_network_tx_hash ON events(network, tx_hash);

-- Add network column to contracts table
ALTER TABLE contracts ADD COLUMN network TEXT NOT NULL DEFAULT 'testnet';

CREATE INDEX IF NOT EXISTS idx_contracts_network ON contracts(network);
CREATE INDEX IF NOT EXISTS idx_contracts_network_id ON contracts(network, id);

-- Add network column to ledger_hashes table
ALTER TABLE ledger_hashes ADD COLUMN network TEXT NOT NULL DEFAULT 'testnet';

ALTER TABLE ledger_hashes DROP CONSTRAINT IF EXISTS ledger_hashes_pkey;
ALTER TABLE ledger_hashes ADD PRIMARY KEY (network, ledger);

-- Add network column to daemon_state table (for per-network cursor tracking)
ALTER TABLE daemon_state ADD COLUMN network TEXT NOT NULL DEFAULT 'testnet';

ALTER TABLE daemon_state DROP CONSTRAINT IF EXISTS daemon_state_pkey;
ALTER TABLE daemon_state ADD PRIMARY KEY (network, key);

-- Add network column to contract_invocations
ALTER TABLE contract_invocations ADD COLUMN network TEXT NOT NULL DEFAULT 'testnet';

CREATE INDEX IF NOT EXISTS idx_contract_invocations_network ON contract_invocations(network);
CREATE INDEX IF NOT EXISTS idx_contract_invocations_network_contract ON contract_invocations(network, contract_id);

-- Add network to verified_contracts
ALTER TABLE verified_contracts ADD COLUMN network TEXT NOT NULL DEFAULT 'testnet';

CREATE INDEX IF NOT EXISTS idx_verified_contracts_network ON verified_contracts(network);

-- Add network to vaults (if exists)
ALTER TABLE IF EXISTS vaults ADD COLUMN network TEXT DEFAULT 'testnet';

-- Add network to api_keys for per-network rate limiting tracking
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS networks TEXT[] DEFAULT ARRAY['testnet'];

-- Add network to webhook_subscriptions for filtering by network
ALTER TABLE webhook_subscriptions ADD COLUMN IF NOT EXISTS network TEXT DEFAULT 'testnet';

CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_network ON webhook_subscriptions(network, active);

-- Add network to dead_letter_queue for per-network retry handling
ALTER TABLE dead_letter_queue ADD COLUMN IF NOT EXISTS network TEXT DEFAULT 'testnet';

CREATE INDEX IF NOT EXISTS idx_dead_letter_queue_network ON dead_letter_queue(network);
