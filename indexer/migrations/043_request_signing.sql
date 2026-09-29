-- Migration 043 (issue #852): HMAC request signing + replay protection.

-- Signing secrets are distinct from the bearer key. Up to two active secrets
-- per key are allowed so a rotation can overlap.
CREATE TABLE IF NOT EXISTS api_key_signing_secrets (
  id          BIGSERIAL PRIMARY KEY,
  key_id      TEXT NOT NULL,
  secret      TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_signing_secrets_key ON api_key_signing_secrets(key_id) WHERE revoked_at IS NULL;

-- Seen nonces. The primary key makes the insert atomic: two concurrent
-- requests with the same nonce → exactly one wins. Rows expire after 2×skew.
CREATE TABLE IF NOT EXISTS used_nonces (
  key_id      TEXT NOT NULL,
  nonce       TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (key_id, nonce)
);
CREATE INDEX IF NOT EXISTS idx_used_nonces_expires ON used_nonces(expires_at);

-- Audit trail for signed (and unsigned, when enforcement is off) mutations.
-- Never stores secret material.
CREATE TABLE IF NOT EXISTS signed_request_audit (
  id          BIGSERIAL PRIMARY KEY,
  outcome     TEXT NOT NULL,          -- signed_ok | signing_missing | rejected
  reason      TEXT,
  key_id      TEXT,
  nonce       TEXT,
  ip          TEXT,
  method      TEXT NOT NULL,
  path        TEXT NOT NULL,
  body_hash   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_signed_request_audit_created ON signed_request_audit(created_at);
