-- API key rotation support (security: rotation grace period).
--
-- auth/apiKeyAuth.js selects rotated_at/rotation_grace_until on every
-- authenticated request, and admin/keyManager.js's rotateKey() writes them,
-- but no prior migration ever added these columns — every request bearing a
-- real DB-issued API key 500ed with "column \"rotated_at\" does not exist".

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS rotated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rotation_grace_until TIMESTAMPTZ;
