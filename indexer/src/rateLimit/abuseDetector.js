import { logger } from "../logger.js";
/**
 * Abuse Detector Middleware
 *
 * Implements five detection patterns using Redis for cross-instance consistency:
 *
 *   1. Auth brute-force  – checks abuse:block:{ip} key on every request
 *   2. Scraping          – URL similarity (Jaccard) > 0.9 over recent requests
 *   3. DDoS              – HyperLogLog PFCOUNT > 50 distinct IPs per endpoint in 10 s
 *   4. Aggressive pagination – > 20 consecutive page params in 60 s
 *   5. Repeat offender   – > 5 rate-limit breaches in 10 min
 *
 * Also exports:
 *   recordAuthFailure(ip, redis)         – INCR authfail counter; block IP at > 10
 *   recordRateLimitBreach(clientId, redis) – INCR breach counter; warn at > 5
 *
 * All Redis operations are wrapped in try/catch — the request is passed through
 * on any Redis failure.
 */

import {
  ABUSE_AUTHFAIL_PREFIX,
  ABUSE_BLOCK_PREFIX,
  ABUSE_SCRAPE_PREFIX,
  ABUSE_DDOS_PREFIX,
  ABUSE_PAGINATE_PREFIX,
  ABUSE_RATELIMITCOUNT_PREFIX,
  ABUSE_PENALTY_PREFIX,
} from './constants.js';
import { getRedisClient } from './tokenBucket.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Auth failure window (seconds). */
const AUTH_FAIL_WINDOW = 60;
/** Auth failure threshold before IP block. */
const AUTH_FAIL_THRESHOLD = 10;
/** IP block duration (seconds) — 15 min. */
const IP_BLOCK_TTL = 900;

/** Number of recent URLs to track per client for scraping detection. */
const SCRAPE_WINDOW_SIZE = 10;
/** Scraping URL similarity threshold. */
const SCRAPE_SIMILARITY_THRESHOLD = 0.9;
/** Scraping penalty TTL (seconds) — 10 min. */
const SCRAPE_PENALTY_TTL = 600;
/** Effective rpm when scraping penalty applies (10% of original, minimum 1). */
const SCRAPE_PENALTY_FACTOR = 0.1;

/** DDoS detection window in seconds. */
const DDOS_WINDOW = 10;
/** Distinct IP threshold for DDoS detection. */
const DDOS_THRESHOLD = 50;

/** Aggressive pagination threshold. */
const PAGINATION_THRESHOLD = 20;
/** Aggressive pagination counter TTL (seconds). */
const PAGINATION_WINDOW = 60;
/** Pagination penalty TTL (seconds) — 5 min. */
const PAGINATION_PENALTY_TTL = 300;
/** Effective rpm applied as pagination penalty. */
const PAGINATION_PENALTY_RATE = 5;

/** Rate limit breach threshold for repeat offender detection. */
const BREACH_THRESHOLD = 5;
/** Rate limit breach counter TTL (seconds) — 10 min. */
const BREACH_WINDOW = 600;

// ── IP extraction ─────────────────────────────────────────────────────────────

/**
 * @param {import('express').Request} req
 * @returns {string}
 */
function extractIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return req.socket?.remoteAddress ?? '0.0.0.0';
}

// ── Jaccard similarity ────────────────────────────────────────────────────────

/**
 * Tokenise a URL path into a set of non-empty path segments.
 *
 * @param {string} urlPath
 * @returns {Set<string>}
 */
function tokenisePath(urlPath) {
  const parts = urlPath.split('/').filter(Boolean);
  return new Set(parts);
}

/**
 * Compute Jaccard similarity between two token sets.
 * Returns a value in [0, 1].
 *
 * @param {Set<string>} a
 * @param {Set<string>} b
 * @returns {number}
 */
function jaccardSimilarity(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;

  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }

  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Compute the average Jaccard similarity between a candidate token set and
 * each set in a list of historical token sets.
 *
 * @param {Set<string>}   candidate
 * @param {Set<string>[]} history
 * @returns {number}
 */
function averageJaccard(candidate, history) {
  if (history.length === 0) return 0;
  const total = history.reduce((sum, h) => sum + jaccardSimilarity(candidate, h), 0);
  return total / history.length;
}

// ── Exported helper functions ─────────────────────────────────────────────────

/**
 * Record an authentication failure for an IP address.
 * If failures exceed AUTH_FAIL_THRESHOLD within AUTH_FAIL_WINDOW, the IP is
 * blocked for IP_BLOCK_TTL seconds.
 *
 * @param {string} ip
 * @param {import('redis').RedisClientType} redis
 * @returns {Promise<void>}
 */
async function recordAuthFailure(ip, redis) {
  try {
    const failKey = `${ABUSE_AUTHFAIL_PREFIX}:${ip}`;
    const count = await redis.incr(failKey);
    if (count === 1) {
      await redis.expire(failKey, AUTH_FAIL_WINDOW);
    }

    if (count > AUTH_FAIL_THRESHOLD) {
      const blockKey = `${ABUSE_BLOCK_PREFIX}:${ip}`;
      await redis.set(blockKey, '1', { EX: IP_BLOCK_TTL });
      logger.warn('[abuseDetector] IP blocked for auth brute-force:', ip);
    }
  } catch (err) {
    // Redis unavailable — log and continue.
    logger.warn('[abuseDetector] recordAuthFailure Redis error:', err.message);
  }
}

/**
 * Record a rate-limit breach for a client.
 * Emits a structured warning log if the client has breached > BREACH_THRESHOLD
 * times within BREACH_WINDOW seconds.
 *
 * @param {string} clientId
 * @param {import('redis').RedisClientType} redis
 * @returns {Promise<void>}
 */
async function recordRateLimitBreach(clientId, redis) {
  try {
    const key = `${ABUSE_RATELIMITCOUNT_PREFIX}:${clientId}`;
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, BREACH_WINDOW);
    }

    if (count > BREACH_THRESHOLD) {
      logger.warn(
        JSON.stringify({
          level: 'warn',
          event: 'repeat_offender',
          clientId,
          breachCount: count,
          windowSeconds: BREACH_WINDOW,
          message: 'Client has exceeded the rate limit repeatedly — flagging as suspicious',
        }),
      );
    }
  } catch (err) {
    logger.warn('[abuseDetector] recordRateLimitBreach Redis error:', err.message);
  }
}

// ── Detection helpers ─────────────────────────────────────────────────────────

/**
 * Check whether the client IP is currently blocked.
 *
 * @param {string}                           ip
 * @param {import('redis').RedisClientType}  redis
 * @returns {Promise<boolean>}
 */
async function isBlocked(ip, redis) {
  try {
    const val = await redis.get(`${ABUSE_BLOCK_PREFIX}:${ip}`);
    return val !== null;
  } catch {
    return false;
  }
}

/**
 * Check for an active penalty on the client for the given endpoint.
 *
 * @param {string}                           clientId
 * @param {string}                           endpoint
 * @param {import('redis').RedisClientType}  redis
 * @returns {Promise<boolean>}
 */
async function hasPenalty(clientId, endpoint, redis) {
  try {
    // Check both the specific endpoint penalty and a wildcard penalty.
    const specificKey = `${ABUSE_PENALTY_PREFIX}:${clientId}:${endpoint}`;
    const wildcardKey = `${ABUSE_PENALTY_PREFIX}:${clientId}:*`;
    const [specific, wildcard] = await Promise.all([
      redis.get(specificKey),
      redis.get(wildcardKey),
    ]);
    return specific !== null || wildcard !== null;
  } catch {
    return false;
  }
}

/**
 * Apply scraping detection: track the last N URLs for the client in a Redis
 * list and compute average Jaccard similarity. If similarity exceeds the
 * threshold, apply a penalty.
 *
 * @param {string}                           clientId
 * @param {string}                           path
 * @param {number}                           originalLimit
 * @param {import('redis').RedisClientType}  redis
 * @returns {Promise<number>}  effective rate limit (may be reduced)
 */
async function checkScrapingPattern(clientId, path, originalLimit, redis) {
  try {
    const scrapeKey = `${ABUSE_SCRAPE_PREFIX}:${clientId}`;

    // Push the current path to the list and trim to the last N entries.
    await redis.rPush(scrapeKey, path);
    await redis.lTrim(scrapeKey, -SCRAPE_WINDOW_SIZE, -1);
    await redis.expire(scrapeKey, SCRAPE_PENALTY_TTL);

    const recent = await redis.lRange(scrapeKey, 0, -1);
    if (recent.length < 3) {
      // Not enough data to compute meaningful similarity.
      return originalLimit;
    }

    const candidateTokens = tokenisePath(path);
    const historyTokenSets = recent
      .slice(0, -1) // exclude the current path we just added
      .map(tokenisePath);

    const similarity = averageJaccard(candidateTokens, historyTokenSets);

    if (similarity > SCRAPE_SIMILARITY_THRESHOLD) {
      // Apply scraping penalty.
      const reducedLimit = Math.max(1, Math.floor(originalLimit * SCRAPE_PENALTY_FACTOR));

      const penaltyKey = `${ABUSE_PENALTY_PREFIX}:${clientId}:*`;
      await redis.set(penaltyKey, '1', { EX: SCRAPE_PENALTY_TTL });

      logger.warn(
        JSON.stringify({
          level: 'warn',
          event: 'scraping_detected',
          clientId,
          similarity: similarity.toFixed(3),
          reducedLimit,
          message: 'Scraping pattern detected — applying rate limit penalty',
        }),
      );

      return reducedLimit;
    }

    return originalLimit;
  } catch {
    return originalLimit;
  }
}

/**
 * Update DDoS HyperLogLog for the endpoint and check threshold.
 *
 * @param {string}                           endpoint
 * @param {string}                           ip
 * @param {import('redis').RedisClientType}  redis
 * @returns {Promise<boolean>}  true if DDoS threshold exceeded
 */
async function checkDDoSPattern(endpoint, ip, redis) {
  try {
    const window = Math.floor(Date.now() / (DDOS_WINDOW * 1000));
    const ddosKey = `${ABUSE_DDOS_PREFIX}:${endpoint}:${window}`;

    await redis.pfAdd(ddosKey, ip);
    // Set TTL slightly longer than the window to allow natural expiry.
    await redis.expire(ddosKey, DDOS_WINDOW * 3);

    const distinctIps = await redis.pfCount(ddosKey);

    return distinctIps > DDOS_THRESHOLD;
  } catch {
    return false;
  }
}

/**
 * Check for aggressive pagination behaviour.
 *
 * @param {string}                           clientId
 * @param {string}                           endpoint
 * @param {import('express').Request}        req
 * @param {import('redis').RedisClientType}  redis
 * @returns {Promise<boolean>}  true if pagination penalty should be applied
 */
async function checkPaginationPattern(clientId, endpoint, req, redis) {
  try {
    const hasPageParam =
      req.query?.page !== undefined ||
      req.query?.offset !== undefined ||
      req.query?.cursor !== undefined;

    if (!hasPageParam) return false;

    const paginateKey = `${ABUSE_PAGINATE_PREFIX}:${clientId}:${endpoint}`;
    const count = await redis.incr(paginateKey);
    if (count === 1) {
      await redis.expire(paginateKey, PAGINATION_WINDOW);
    }

    if (count > PAGINATION_THRESHOLD) {
      const penaltyKey = `${ABUSE_PENALTY_PREFIX}:${clientId}:${endpoint}`;
      await redis.set(penaltyKey, '1', { EX: PAGINATION_PENALTY_TTL });
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Fire-and-forget POST to the Cloudflare DDoS mitigation webhook.
 *
 * @param {string} endpoint
 * @param {number} distinctIps
 */
function notifyCloudflare(endpoint, distinctIps) {
  const webhookUrl = process.env.CLOUDFLARE_WEBHOOK_URL;
  if (!webhookUrl) return;

  const payload = {
    event: 'ddos_detected',
    endpoint,
    distinctIps,
    timestamp: new Date().toISOString(),
  };

  // Fire-and-forget using built-in Node 18+ fetch.
  fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch((err) => {
    logger.warn('[abuseDetector] Cloudflare webhook notification failed:', err.message);
  });
}

// ── Middleware ─────────────────────────────────────────────────────────────────

/**
 * Express middleware that detects and mitigates request abuse patterns.
 *
 * Checks on every request:
 *   1. IP block (auth brute-force) — return 403
 *   2. Active penalty — reduce effective rate limit
 *
 * After response (res.on('finish')):
 *   3. Record rate-limit breach on 429
 *   4. DDoS detection via HyperLogLog
 *
 * Also runs:
 *   5. Scraping detection (URL similarity)
 *   6. Aggressive pagination detection
 *
 * @type {import('express').RequestHandler}
 */
async function abuseDetector(req, res, next) {
  const ip = extractIp(req);
  const rateContext = req.rateContext ?? {
    clientId: 'unknown',
    tier: 'unauthenticated',
    rateLimit: null,
  };
  const { clientId } = rateContext;
  const endpoint = req.path;

  let redis = null;
  try {
    redis = await getRedisClient();
  } catch {
    // Redis unavailable — pass through.
    return next();
  }

  if (!redis?.isReady) {
    return next();
  }

  // ── 1. Check IP block ──────────────────────────────────────────────────────
  try {
    const blocked = await isBlocked(ip, redis);
    if (blocked) {
      return res.status(403).json({ error: 'Request blocked' });
    }
  } catch {
    // Continue on Redis error.
  }

  // ── 2. Check active penalty ────────────────────────────────────────────────
  try {
    const penalised = await hasPenalty(clientId, endpoint, redis);
    if (penalised) {
      req.rateContext = { ...rateContext, rateLimit: 5 };
    }
  } catch {
    // Continue on Redis error.
  }

  // ── 5. Scraping detection ──────────────────────────────────────────────────
  try {
    const originalLimit = req.rateContext.rateLimit ?? 60;
    const effectiveLimit = await checkScrapingPattern(clientId, req.path, originalLimit, redis);
    if (effectiveLimit < originalLimit) {
      req.rateContext = { ...req.rateContext, rateLimit: effectiveLimit };
    }
  } catch {
    // Continue.
  }

  // ── 6. Aggressive pagination ───────────────────────────────────────────────
  try {
    const paginationPenalty = await checkPaginationPattern(clientId, endpoint, req, redis);
    if (paginationPenalty) {
      req.rateContext = { ...req.rateContext, rateLimit: PAGINATION_PENALTY_RATE };
    }
  } catch {
    // Continue.
  }

  // ── Post-response hooks ────────────────────────────────────────────────────
  res.on('finish', () => {
    // 3. Record rate-limit breach on 429.
    if (res.statusCode === 429) {
      getRedisClient()
        .then((r) => {
          if (r?.isReady) return recordRateLimitBreach(clientId, r);
        })
        .catch(() => {});
    }

    // 4. DDoS detection.
    getRedisClient()
      .then(async (r) => {
        if (!r?.isReady) return;
        const isDDoS = await checkDDoSPattern(endpoint, ip, r);
        if (isDDoS) {
          const window = Math.floor(Date.now() / (DDOS_WINDOW * 1000));
          const ddosKey = `${ABUSE_DDOS_PREFIX}:${endpoint}:${window}`;
          const distinctIps = await r.pfCount(ddosKey).catch(() => 0);

          logger.warn(
            JSON.stringify({
              level: 'warn',
              event: 'ddos_detected',
              endpoint,
              distinctIps,
              windowSeconds: DDOS_WINDOW,
              message: 'DDoS threshold exceeded — consider activating mitigation',
            }),
          );

          notifyCloudflare(endpoint, distinctIps);
        }
      })
      .catch(() => {});
  });

  return next();
}

export {
  abuseDetector,
  recordAuthFailure,
  recordRateLimitBreach,
  jaccardSimilarity,
  tokenisePath,
  averageJaccard,
};
