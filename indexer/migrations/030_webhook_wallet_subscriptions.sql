-- Migration 030: wallet address subscriptions for webhooks
--
-- Extends webhook_subscriptions to support notifications for wallet activity
-- by adding a wallet_address column. A subscription can filter by:
--   - contract_id (existing, nullable)
--   - function_filter (existing, nullable)
--   - wallet_address (new, nullable — matches events involving this address)
--
-- An event matches if all non-NULL filters match.

ALTER TABLE webhook_subscriptions ADD COLUMN wallet_address TEXT DEFAULT NULL;

-- Index for wallet-based lookups on new-event dispatch: active subscriptions for a wallet.
CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_wallet
  ON webhook_subscriptions (wallet_address) WHERE active = TRUE;
