-- Migration 029: webhook delivery log
--
-- One row per delivery attempt (initial send + every DLQ-driven retry), so
-- GET /api/webhooks/:id/deliveries can show a full history per subscription.
-- `created_at` is separate from `delivered_at` because a failed attempt never
-- sets `delivered_at` but still needs a timestamp to sort/paginate on.

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id              BIGSERIAL   PRIMARY KEY,
  webhook_id      UUID        NOT NULL REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,
  event_seq       BIGINT,
  url             TEXT        NOT NULL,
  request_body    TEXT        NOT NULL,
  response_status INT,
  response_body   TEXT,
  duration_ms     INT,
  delivered_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook
  ON webhook_deliveries (webhook_id, created_at DESC);
