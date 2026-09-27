-- Moderation queue for registry submissions (#934).
-- Moderation state only curates explorer metadata; on-chain events are never
-- hidden. Status: published | pending (published, badge, excluded from search
-- ranking) | held (queued, not listed) | hidden | rejected.
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS moderation_status TEXT NOT NULL DEFAULT 'published';
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS risk_score INT NOT NULL DEFAULT 0;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS risk_signals JSONB NOT NULL DEFAULT '[]';
CREATE INDEX IF NOT EXISTS idx_contracts_moderation_status ON contracts (moderation_status);

CREATE TABLE IF NOT EXISTS moderation_reports (
  id            BIGSERIAL PRIMARY KEY,
  contract_id   TEXT NOT NULL,
  reporter      TEXT NOT NULL,          -- API key id or ip:<addr>
  reason        TEXT NOT NULL,
  details       TEXT,
  weight        REAL NOT NULL DEFAULT 1,
  resolved      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_moderation_reports_contract ON moderation_reports (contract_id, resolved);
CREATE INDEX IF NOT EXISTS idx_moderation_reports_reporter ON moderation_reports (reporter, created_at);

-- Reporter reputation: reports that led to action raise weight, dismissed
-- reports lower it (brigade resistance).
CREATE TABLE IF NOT EXISTS moderation_reporters (
  reporter   TEXT PRIMARY KEY,
  upheld     INT NOT NULL DEFAULT 0,
  dismissed  INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS moderation_appeals (
  id           BIGSERIAL PRIMARY KEY,
  contract_id  TEXT NOT NULL,
  submitter    TEXT NOT NULL,
  message      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open',   -- open | granted | denied
  decided_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_moderation_appeals_status ON moderation_appeals (status);

-- Append-only audit log of every moderation action. onchain_status tracks
-- mirroring to the explorer contract's Moderator role (deregister_contract).
CREATE TABLE IF NOT EXISTS moderation_actions (
  id              BIGSERIAL PRIMARY KEY,
  contract_id     TEXT NOT NULL,
  action          TEXT NOT NULL,   -- submit | approve | reject | hide | ban | report | appeal | appeal_granted | appeal_denied
  actor           TEXT NOT NULL,
  from_status     TEXT,
  to_status       TEXT,
  notice          TEXT,
  evidence        JSONB NOT NULL DEFAULT '{}',
  onchain_status  TEXT,            -- NULL | pending | mirrored
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_moderation_actions_contract ON moderation_actions (contract_id, created_at DESC);

CREATE TABLE IF NOT EXISTS moderation_banned_submitters (
  submitter   TEXT PRIMARY KEY,
  reason      TEXT,
  banned_by   TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
