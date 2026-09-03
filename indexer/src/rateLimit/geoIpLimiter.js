import { logger } from "../logger.js";
/**
 * GeoIP Rate Limiter Middleware
 *
 * Uses the MaxMind GeoLite2-Country database (via the `maxmind` npm package)
 * to resolve the client IP to a country/region code and then either:
 *   - Blocks the request (403) if the region is in GEO_BLOCK_LIST
 *   - Multiplies the effective rate limit if the region is in GEO_RATE_MULTIPLIERS
 *   - Passes through unchanged otherwise
 *
 * Environment variables:
 *   GEOIP_DB_PATH         – path to GeoLite2-Country.mmdb (optional)
 *   GEO_BLOCK_LIST        – comma-separated ISO-3166 country codes to block
 *   GEO_RATE_MULTIPLIERS  – JSON map of country code → float multiplier
 *                           e.g. {"US": 1.5, "CN": 0.5}
 *
 * Gracefully passes through (calls next()) when:
 *   - GEOIP_DB_PATH is unset
 *   - The database file is missing or fails to load
 *   - The IP lookup fails
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';

// ── Lazy-loaded MaxMind reader ────────────────────────────────────────────────

let _maxmindReader = null;
let _maxmindLoadAttempted = false;

/**
 * Lazily load the MaxMind GeoLite2-Country database.
 * Returns the reader instance or null if unavailable.
 *
 * @returns {Promise<object|null>}
 */
async function getMaxmindReader() {
  if (_maxmindLoadAttempted) return _maxmindReader;
  _maxmindLoadAttempted = true;

  const dbPath = process.env.GEOIP_DB_PATH;
  if (!dbPath) return null;

  if (!existsSync(dbPath)) {
    logger.warn('[geoIpLimiter] GeoLite2 database file not found at:', dbPath);
    return null;
  }

  try {
    // Dynamic import so the module is only loaded when actually needed.
    const maxmind = await import('maxmind');
    const open = maxmind.default?.open ?? maxmind.open;
    _maxmindReader = await open(dbPath);
    logger.info('[geoIpLimiter] MaxMind GeoLite2-Country database loaded from:', dbPath);
  } catch (err) {
    logger.warn('[geoIpLimiter] Failed to load MaxMind database:', err.message);
    _maxmindReader = null;
  }

  return _maxmindReader;
}

// ── Config helpers ─────────────────────────────────────────────────────────────

/**
 * Parse GEO_BLOCK_LIST env into an uppercase Set of country codes.
 * @returns {Set<string>}
 */
function getBlockList() {
  const raw = process.env.GEO_BLOCK_LIST ?? '';
  if (!raw.trim()) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  );
}

/**
 * Parse GEO_RATE_MULTIPLIERS env into a map of uppercase country code → float.
 * @returns {Record<string, number>}
 */
function getRateMultipliers() {
  const raw = process.env.GEO_RATE_MULTIPLIERS;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    // Normalise keys to uppercase.
    const result = {};
    for (const [k, v] of Object.entries(parsed)) {
      const multiplier = Number(v);
      if (k && Number.isFinite(multiplier) && multiplier > 0) {
        result[k.toUpperCase()] = multiplier;
      }
    }
    return result;
  } catch {
    logger.warn('[geoIpLimiter] Failed to parse GEO_RATE_MULTIPLIERS — using empty map');
    return {};
  }
}

// ── IP extraction ─────────────────────────────────────────────────────────────

/**
 * Extract the best-effort client IP from the request.
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
function extractClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return String(forwarded).split(',')[0].trim();
  }
  return req.socket?.remoteAddress ?? '0.0.0.0';
}

// ── Middleware ─────────────────────────────────────────────────────────────────

/**
 * Express middleware that applies GeoIP-based blocking and rate multipliers.
 *
 * Reads/modifies req.rateContext.rateLimit to apply the regional multiplier.
 * Returns 403 for blocked regions.
 * Passes through transparently if the GeoIP database is unavailable.
 *
 * @type {import('express').RequestHandler}
 */
async function geoIpRateLimiter(req, res, next) {
  try {
    const reader = await getMaxmindReader();
    if (!reader) {
      // No database available — pass through.
      return next();
    }

    const ip = extractClientIp(req);
    let countryCode = null;

    try {
      const result = reader.get(ip);
      countryCode = result?.country?.iso_code?.toUpperCase() ?? null;
    } catch {
      // Lookup failure — pass through.
      return next();
    }

    if (!countryCode) {
      return next();
    }

    const blockList = getBlockList();
    if (blockList.has(countryCode)) {
      return res.status(403).json({ error: 'Region not permitted' });
    }

    const multipliers = getRateMultipliers();
    if (multipliers[countryCode] !== undefined) {
      const multiplier = multipliers[countryCode];

      // Ensure rateContext exists.
      if (!req.rateContext) {
        req.rateContext = {
          clientId: 'unknown',
          tier: 'unauthenticated',
          rateLimit: null,
          keyId: null,
          keyName: null,
        };
      }

      // Apply multiplier to existing rateLimit override, or derive from tier default.
      if (req.rateContext.rateLimit != null) {
        req.rateContext.rateLimit = Math.round(req.rateContext.rateLimit * multiplier);
      } else {
        // Store the multiplier for downstream middleware (tokenBucket) to use.
        // We attach it as a separate field so token bucket can compute
        // the effective limit when no explicit override exists.
        req.rateContext.geoMultiplier = multiplier;
      }
    }

    return next();
  } catch (err) {
    logger.error('[geoIpLimiter] Unexpected error:', err.message);
    // Fail open — do not block requests on unexpected errors.
    return next();
  }
}

// Export for testing.
export { geoIpRateLimiter, getMaxmindReader, extractClientIp, getBlockList, getRateMultipliers };
