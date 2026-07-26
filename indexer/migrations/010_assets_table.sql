-- Migration 010: classic asset metadata cache — code/issuer -> display name + logo
-- resolved from the issuer's stellar.toml (#546).

CREATE TABLE IF NOT EXISTS assets (
  code        TEXT NOT NULL,
  issuer      TEXT NOT NULL,
  name        TEXT,
  domain      TEXT,
  logo_url    TEXT,
  resolved_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (code, issuer)
);

CREATE INDEX IF NOT EXISTS idx_assets_issuer ON assets(issuer);
