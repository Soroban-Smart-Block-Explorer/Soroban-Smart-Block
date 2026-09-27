-- Developer accounts with passkey (WebAuthn) sign-in (#933).
-- Sessions and one-time tokens are stored as SHA-256 hashes only.

CREATE TABLE IF NOT EXISTS accounts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email            TEXT NOT NULL UNIQUE,
  stellar_address  TEXT UNIQUE,            -- optional SEP-10 wallet sign-in
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id            TEXT PRIMARY KEY,           -- credential id (base64url)
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  public_key    BYTEA NOT NULL,
  counter       BIGINT NOT NULL DEFAULT 0,
  transports    TEXT[] NOT NULL DEFAULT '{}',  -- includes "hybrid" for cross-device passkeys
  device_type   TEXT,
  backed_up     BOOLEAN NOT NULL DEFAULT FALSE,
  name          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_account ON webauthn_credentials (account_id);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id_hash         TEXT PRIMARY KEY,
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  auth_method     TEXT NOT NULL,            -- passkey | email | recovery | stellar
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,     -- absolute timeout
  elevated_until  TIMESTAMPTZ,              -- step-up window
  revoked_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_account ON auth_sessions (account_id);

-- WebAuthn / SEP-10 challenges, bound to a short-lived HttpOnly cookie.
CREATE TABLE IF NOT EXISTS auth_challenges (
  id_hash     TEXT PRIMARY KEY,
  purpose     TEXT NOT NULL,                -- register | login | step_up | stellar
  challenge   TEXT NOT NULL,
  account_id  UUID REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL
);

-- Email links: signup (first passkey), claim (link existing API keys), recovery.
CREATE TABLE IF NOT EXISTS auth_email_tokens (
  token_hash  TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  purpose     TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS recovery_codes (
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL,
  used_at     TIMESTAMPTZ,
  PRIMARY KEY (account_id, code_hash)
);

-- Existing key holders claim their keys into an account via the email flow.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES accounts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_api_keys_account ON api_keys (account_id);
