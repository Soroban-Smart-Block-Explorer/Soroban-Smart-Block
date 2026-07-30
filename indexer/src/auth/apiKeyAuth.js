/**
 * API Key Authenticator Middleware
 *
 * Responsibilities:
 * - Extract the `x-api-key` header; fall back to a hashed client IP for
 *   unauthenticated identity.
 * - Look up the key record in PostgreSQL by `key_prefix` (first 8 chars),
 *   then verify the full key against the stored bcrypt hash.
 * - Maintain an in-memory LRU cache (TTL 30 s, max 1 000 entries) to avoid
 *   per-request DB hits.
 * - Validate: not revoked, not expired, IP CIDR whitelist, endpoint whitelist.
 * - Attach `req.rateContext` consumed by downstream middleware.
 * - Return 401/403 error responses as specified in the design.
 * - Asynchronously update `last_used_at` and `usage_count` on every
 *   authenticated request.
 */

import crypto from "crypto";
import bcrypt from "bcryptjs";
import { LRUCache } from "lru-cache";
import { pool } from "../db.js";

// ── In-memory LRU cache ───────────────────────────────────────────────────────
// Caches resolved key records keyed by the raw API key string.
// TTL: 30 seconds, max: 1 000 entries.
const KEY_CACHE_TTL_MS = 30_000;
const KEY_CACHE_MAX = 1_000;

const keyCache = new LRUCache({
  max: KEY_CACHE_MAX,
  ttl: KEY_CACHE_TTL_MS,
});

const DAILY_LIMIT_BY_TIER = {
  unauthenticated: 60,
  free: 1000,
  pro: 10000,
  enterprise: 100000,
};

// ── CIDR helpers ──────────────────────────────────────────────────────────────

/**
 * Convert an IPv4 address string to a 32-bit integer.
 * @param {string} ip
 * @returns {number}
 */
function ipv4ToInt(ip) {
  return ip.split(".").reduce((acc, octet) => (acc << 8) | parseInt(octet, 10), 0) >>> 0;
}

/**
 * Check whether an IPv4 address matches a CIDR block.
 * @param {string} ip     e.g. "192.168.1.5"
 * @param {string} cidr   e.g. "192.168.1.0/24"
 * @returns {boolean}
 */
function ipMatchesCidr(ip, cidr) {
  // Handle plain IP (no prefix length) as /32.
  const [range, prefixStr] = cidr.includes("/") ? cidr.split("/") : [cidr, "32"];
  const prefix = parseInt(prefixStr, 10);
  const mask = prefix === 0 ? 0 : ~((1 << (32 - prefix)) - 1) >>> 0;
  try {
    return (ipv4ToInt(ip) & mask) === (ipv4ToInt(range) & mask);
  } catch {
    return false;
  }
}

/**
 * Return true if `ip` matches any entry in the CIDR list.
 * @param {string}   ip
 * @param {string[]} cidrList
 * @returns {boolean}
 */
function ipInCidrList(ip, cidrList) {
  if (!Array.isArray(cidrList) || cidrList.length === 0) return true;
  return cidrList.some((cidr) => ipMatchesCidr(ip, cidr));
}

// ── Endpoint whitelist helper ─────────────────────────────────────────────────

/**
 * Return true if `endpoint` matches any pattern in the whitelist.
 * Patterns support a trailing `*` wildcard.
 * @param {string}   endpoint  e.g. "/api/events"
 * @param {string[]} patterns  e.g. ["/api/events*", "/api/contracts"]
 * @returns {boolean}
 */
function endpointAllowed(endpoint, patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) return true;
  return patterns.some((pattern) => {
    if (pattern.endsWith("*")) {
      return endpoint.startsWith(pattern.slice(0, -1));
    }
    return endpoint === pattern;
  });
}

// ── Client IP extraction ──────────────────────────────────────────────────────

/**
 * Extract the real client IP from the request, respecting common proxy headers.
 * @param {import('express').Request} req
 * @returns {string}
 */
function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    // x-forwarded-for can be a comma-separated list; take the first (client) IP.
    return String(forwarded).split(",")[0].trim();
  }
  return req.socket?.remoteAddress ?? "0.0.0.0";
}

/**
 * Produce a stable, opaque clientId from an IP address by SHA-256 hashing.
 * This avoids storing raw IPs in rateContext for unauthenticated clients.
 * @param {string} ip
 * @returns {string}  hex string prefixed with "ip:"
 */
function hashIp(ip) {
  return "ip:" + crypto.createHash("sha256").update(ip).digest("hex").slice(0, 16);
}

// ── Database lookup ───────────────────────────────────────────────────────────

/**
 * Fetch the api_keys row whose key_prefix matches the first 8 characters of
 * the raw key, then verify the full key against the stored bcrypt hash.
 *
 * Returns the row on success, `null` if no row found or the hash does not
 * match.
 *
 * @param {string} rawKey
 * @returns {Promise<object|null>}
 */
async function lookupKeyInDb(rawKey) {
  const prefix = rawKey.slice(0, 8);

  const { rows } = await pool.query(
    `SELECT id, name, key_hash, tier, rate_limit, daily_limit,
            allowed_ips, allowed_endpoints, expires_at,
            revoked, verified, last_used_at, usage_count,
            rotated_at, rotation_grace_until
     FROM   api_keys
     WHERE  key_prefix = $1`,
    [prefix],
  );

  if (rows.length === 0) return null;

  // There may be multiple rows for the same prefix (extremely unlikely but
  // possible). Test each until one matches.
  for (const row of rows) {
    const match = await bcrypt.compare(rawKey, row.key_hash);
    if (match) return row;
  }

  return null;
}

/**
 * Increment the per-day API key request counter and enforce the tier daily limit
 * synchronously for the current request.
 *
 * @param {object} keyRecord
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<boolean>} true if the request should continue, false if 429
 */
async function incrementDailyUsage(keyRecord, req, res) {
  const todayUtc = `((NOW() AT TIME ZONE 'UTC')::DATE)`;
  const { rows } = await pool.query(
    `INSERT INTO api_key_usage (api_key_id, date, request_count)
     VALUES ($1, ${todayUtc}, 1)
     ON CONFLICT (api_key_id, date)
     DO UPDATE SET request_count = api_key_usage.request_count + 1
     RETURNING request_count`,
    [keyRecord.id],
  );

  const count = Number(rows[0]?.request_count ?? 0);
  const dailyLimit = Number(keyRecord.daily_limit);
  const effectiveDailyLimit =
    Number.isFinite(dailyLimit) && dailyLimit >= 0
      ? dailyLimit
      : (DAILY_LIMIT_BY_TIER[keyRecord.tier] ?? DAILY_LIMIT_BY_TIER.free);

  if (count > effectiveDailyLimit) {
    return res.status(429).json({ error: "Daily API key usage limit exceeded" });
  }

  await pool.query(
    `UPDATE api_keys
     SET last_used_at = NOW(),
         usage_count  = usage_count + 1
     WHERE id = $1`,
    [keyRecord.id],
  );

  return true;
}

// ── Middleware factory ────────────────────────────────────────────────────────

/**
 * Express middleware that authenticates the incoming request via the
 * `x-api-key` header and attaches `req.rateContext`.
 *
 * For unauthenticated requests (no header), the client is assigned the
 * `unauthenticated` tier using a hashed IP as the clientId.
 *
 * Error responses (per design):
 *   401 { "error": "Invalid API key" }    — unrecognised key
 *   401 { "error": "API key expired" }    — past `expires_at`
 *   401 { "error": "API key revoked" }    — `revoked = true`
 *   403 { "error": "IP not permitted" }   — CIDR mismatch
 *   403 { "error": "Endpoint not permitted" } — endpoint mismatch
 *
 * @type {import('express').RequestHandler}
 */
async function apiKeyAuthenticator(req, res, next) {
  try {
    const rawKey = req.headers["x-api-key"];

    // ── Unauthenticated path ────────────────────────────────────────────────
    if (!rawKey) {
      req.rateContext = {
        clientId: hashIp(getClientIp(req)),
        tier: "unauthenticated",
        rateLimit: null,
        keyId: null,
        keyName: null,
      };
      return next();
    }

    // ── Authenticated path ──────────────────────────────────────────────────

    // Legacy static admin key (ADMIN_SECRET-style shared secret via API_KEY):
    // predates the per-key DB-backed system above and is still relied on by
    // route-level `requireApiKey` checks in api.js.
    const staticAdminKey = process.env.API_KEY;
    if (staticAdminKey && rawKey === staticAdminKey) {
      req.rateContext = {
        clientId: "static-admin-key",
        tier: "enterprise",
        rateLimit: null,
        keyId: null,
        keyName: "static-admin-key",
      };
      return next();
    }

    // 1. Try LRU cache first.
    let keyRecord = keyCache.get(rawKey);

    if (keyRecord === undefined) {
      // 2. Cache miss → query the database.
      const dbRecord = await lookupKeyInDb(rawKey);

      if (!dbRecord) {
        return res.status(401).json({ error: "Invalid API key" });
      }

      keyRecord = dbRecord;

      // Normalise JSONB fields that may come back as strings in some drivers.
      keyRecord.allowed_ips =
        typeof keyRecord.allowed_ips === "string" ? JSON.parse(keyRecord.allowed_ips) : keyRecord.allowed_ips;
      keyRecord.allowed_endpoints =
        typeof keyRecord.allowed_endpoints === "string"
          ? JSON.parse(keyRecord.allowed_endpoints)
          : keyRecord.allowed_endpoints;

      // Normalise rotation timestamps
      keyRecord.rotated_at = keyRecord.rotated_at ?? null;
      keyRecord.rotation_grace_until = keyRecord.rotation_grace_until ?? null;

      keyCache.set(rawKey, keyRecord);
    }

    // 3. Validate the cached record.

    // Revoked check with rotation grace allowance.
    // Accept the key if it is not revoked OR the rotation_grace_until is
    // in the future (old key still within grace period).
    if (keyRecord.revoked) {
      const grace = keyRecord.rotation_grace_until ? new Date(keyRecord.rotation_grace_until) : null;
      if (!grace || grace <= new Date()) {
        return res.status(401).json({ error: "API key revoked" });
      }
      // else: within grace period — allow authentication to proceed
    }

    // Verification check - unverified keys cannot authenticate
    if (keyRecord.verified === false) {
      return res.status(401).json({ error: "API key not verified. Please check your email to verify your key." });
    }

    // Expiry check.
    if (keyRecord.expires_at && new Date(keyRecord.expires_at) < new Date()) {
      return res.status(401).json({ error: "API key expired" });
    }

    // IP CIDR whitelist check.
    if (keyRecord.allowed_ips && keyRecord.allowed_ips.length > 0) {
      const clientIp = getClientIp(req);
      if (!ipInCidrList(clientIp, keyRecord.allowed_ips)) {
        return res.status(403).json({ error: "IP not permitted" });
      }
    }

    // Endpoint whitelist check.
    if (keyRecord.allowed_endpoints && keyRecord.allowed_endpoints.length > 0) {
      const endpoint = req.path;
      if (!endpointAllowed(endpoint, keyRecord.allowed_endpoints)) {
        return res.status(403).json({ error: "Endpoint not permitted" });
      }
    }

    // 4. Attach rateContext.
    req.rateContext = {
      clientId: keyRecord.id,
      tier: keyRecord.tier,
      rateLimit: keyRecord.rate_limit ?? null,
      keyId: keyRecord.id,
      keyName: keyRecord.name,
    };

    // 5. Enforce the per-day API key limit synchronously, then continue.
    const canProceed = await incrementDailyUsage(keyRecord, req, res);
    if (canProceed !== true) {
      return canProceed;
    }

    return next();
  } catch (err) {
    console.error("[apiKeyAuth] Unexpected error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

export { apiKeyAuthenticator, keyCache, ipMatchesCidr, ipInCidrList, endpointAllowed, hashIp };
