-- Migration 026: Add request_body_hash to audit log for security audit trail
--
-- Captures SHA256 hash of request bodies for all state-changing API calls
-- (POST/PUT/PATCH/DELETE) to enable non-repudiation and forensic analysis.

ALTER TABLE api_audit_log ADD COLUMN IF NOT EXISTS request_body_hash TEXT;

COMMENT ON COLUMN api_audit_log.request_body_hash IS
  'SHA256 hex digest of the request body (JSON.stringify of parsed body). NULL for GET/HEAD/OPTIONS and bodiless requests.';
