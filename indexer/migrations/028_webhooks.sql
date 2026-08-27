-- Migration 028: webhook subscriptions
--
-- A subscription lets an API key holder receive an outbound POST whenever a
-- matching contract event is indexed. Delivery attempts are logged in
-- webhook_deliveries (migration 029) and retried via the dead_letter_queue
-- (see indexer/src/webhookDelivery.js).

CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key_id        UUID        NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  url               TEXT        NOT NULL,
  contract_id       TEXT,                 -- NULL = all contracts
  function_filter   TEXT,                 -- NULL = all functions
  secret            TEXT        NOT NULL, -- HMAC-SHA256 signing secret
  active            BOOLEAN     NOT NULL DEFAULT TRUE,
  failure_count     INT         NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_triggered_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_api_key
  ON webhook_subscriptions (api_key_id);

-- Matching lookup on new-event dispatch: active subscriptions for a contract.
CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_contract
  ON webhook_subscriptions (contract_id) WHERE active = TRUE;
