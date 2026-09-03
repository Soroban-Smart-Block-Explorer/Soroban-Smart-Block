/**
 * Admin Authentication Middleware
 *
 * Checks the `Authorization: Bearer <token>` header against `ADMIN_SECRET`.
 * `ADMIN_SECRET` may hold a comma-separated list of secrets so an operator
 * can rotate it without downtime: deploy both the old and new secret
 * together, then remove the old one once the grace window has passed —
 * mirroring the rotation_grace_until pattern used for API keys.
 * Uses crypto.timingSafeEqual to prevent timing-based secret enumeration.
 *
 * When `ADMIN_TOTP_SECRET` is set (non-empty), also requires a valid TOTP code
 * in the `X-Admin-TOTP` header (RFC 6238, authenticator apps).
 *
 * Returns 401 `{ error: "Unauthorized" }` if the header is missing, malformed,
 * or the token does not match. When Bearer is valid but TOTP fails, the body
 * also includes `totp_required: true`. Calls next() if auth succeeds.
 */

import crypto from 'crypto';
import { getClientIp, ipInCidrList } from './ipUtils.js';
import { verifyTotp } from './totp.js';

/**
 * Express middleware that enforces admin authentication via a Bearer token.
 *
 * Reads `process.env.ADMIN_SECRET` at request time so that tests can set
 * the variable after module load.
 *
 * @type {import('express').RequestHandler}
 */
function adminAuthMiddleware(req, res, next) {
  const adminSecretsRaw = process.env.ADMIN_SECRET;

  // If ADMIN_SECRET is not configured, block all admin access.
  if (!adminSecretsRaw) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const validSecrets = adminSecretsRaw.split(',').map((s) => s.trim()).filter(Boolean);

  // Optional IP allowlist: if set, enforce it BEFORE checking the token so
  // that disallowed IPs receive 403 even without a valid auth header.
  const allowlist = process.env.ADMIN_IP_ALLOWLIST;
  if (allowlist) {
    const cidrs = allowlist.split(',').map((s) => s.trim()).filter(Boolean);
    const clientIp = getClientIp(req);
    if (!ipInCidrList(clientIp, cidrs)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
  }

  const authHeader = req.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = authHeader.slice('Bearer '.length);

  // Use timingSafeEqual to avoid timing attacks. Check the token against
  // every currently-valid secret (old + new during a rotation window) —
  // both buffers must be the same byte length for the comparison to work.
  try {
    const tokenBuf = Buffer.from(token);

    const match = validSecrets.some((secret) => {
      const secretBuf = Buffer.from(secret);
      if (tokenBuf.length !== secretBuf.length) return false;
      return crypto.timingSafeEqual(tokenBuf, secretBuf);
    });

    if (!match) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  } catch {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Optional TOTP second factor (opt-in when ADMIN_TOTP_SECRET is set).
  const totpSecret = process.env.ADMIN_TOTP_SECRET;
  if (totpSecret) {
    const raw = req.headers['x-admin-totp'];
    const code = Array.isArray(raw) ? raw[0] : raw;
    if (!verifyTotp(totpSecret, code ?? '')) {
      return res.status(401).json({ error: 'Unauthorized', totp_required: true });
    }
  }

  return next();
}

export { adminAuthMiddleware };
