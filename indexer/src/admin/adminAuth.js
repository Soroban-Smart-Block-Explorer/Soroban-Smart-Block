/**
 * Admin Authentication Middleware
 *
 * Checks the `Authorization: Bearer <token>` header against `ADMIN_SECRET`.
 * Uses crypto.timingSafeEqual to prevent timing-based secret enumeration.
 *
 * Returns 401 `{ error: "Unauthorized" }` if the header is missing, malformed,
 * or the token does not match. Calls next() if the token is valid.
 */

import crypto from 'crypto';
import { getClientIp, ipInCidrList } from './ipUtils.js';

/**
 * Express middleware that enforces admin authentication via a Bearer token.
 *
 * Reads `process.env.ADMIN_SECRET` at request time so that tests can set
 * the variable after module load.
 *
 * @type {import('express').RequestHandler}
 */
function adminAuthMiddleware(req, res, next) {
  const adminSecret = process.env.ADMIN_SECRET;

  // If ADMIN_SECRET is not configured, block all admin access.
  if (!adminSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

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

  // Use timingSafeEqual to avoid timing attacks.
  // Both buffers must be the same byte length for the comparison to work.
  try {
    const tokenBuf = Buffer.from(token);
    const secretBuf = Buffer.from(adminSecret);

    // If lengths differ the key is clearly wrong, but we still do the
    // comparison on equal-length buffers to avoid early exit leaking info.
    if (tokenBuf.length !== secretBuf.length) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const match = crypto.timingSafeEqual(tokenBuf, secretBuf);
    if (!match) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  } catch {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  return next();
}

export { adminAuthMiddleware };
