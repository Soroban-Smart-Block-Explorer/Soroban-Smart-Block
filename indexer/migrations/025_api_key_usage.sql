-- Migration 025: daily API key usage tracking

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS daily_limit INTEGER NULL;

CREATE TABLE IF NOT EXISTS api_key_usage (
  api_key_id   UUID        NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  date         DATE        NOT NULL,
  request_count INT         NOT NULL DEFAULT 0,
  PRIMARY KEY (api_key_id, date)
);

CREATE INDEX IF NOT EXISTS idx_api_key_usage_date
  ON api_key_usage (date DESC);
