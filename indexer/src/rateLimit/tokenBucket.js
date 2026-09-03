import { logger } from "../logger.js";
/**
 * Token Bucket Rate Limiter Middleware
 *
 * Implements per-client, per-endpoint-group rate limiting using the Redis
 * `CL.THROTTLE` command (redis-cell / RedisBloom GCRA implementation).
 *
 * Key format: rl:{clientId}:{endpointGroup}
 *
 * CL.THROTTLE syntax:
 *   CL.THROTTLE <key> <max_burst> <count_per_period> <period_seconds> [<quantity>]
 *
 *   max_burst        = burst - 1  (extra tokens above the sustained rate)
 *   count_per_period = rpm value from tier config
 *   period_seconds   = 60
 *   quantity         = 1  (each request consumes 1 token)
 *
 * CL.THROTTLE response array (indices):
 *   [0] allowed   – 0 = allowed, 1 = rate limited
 *   [1] limit     – total tokens (max_burst + 1)
 *   [2] remaining – tokens remaining after this request
 *   [3] retryAfter – seconds until next token (-1 if not limited)
 *   [4] resetAfter – seconds until bucket is fully replenished
 *
 * On Redis failure the middleware falls back to an in-process token bucket
 * implemented with a Map and emits a warn-level log. The fallback is
 * intentionally simple (no persistence, no cross-instance sharing) and is
 * only meant to keep the service functional when Redis is temporarily down.
 *
 * Attaches req.rateLimitState for the downstream header writer:
 *   { limit, remaining, reset, tier }
 */

import { createClient } from 'redis';
import { resolveEndpointGroup, getTierLimits } from './endpointGroups.js';
import { RL_PREFIX } from './constants.js';

// ── Redis client (lazy singleton) ─────────────────────────────────────────────

let _redis = null;
let _redisConnecting = false;

/**
 * Returns a connected Redis client or null if Redis is unavailable.
 * Uses lazy initialisation so the module can be imported before REDIS_URL
 * is set (e.g. during tests).
 *
 * @returns {Promise<import('redis').RedisClientType|null>}
 */
async function getRedisClient() {
  if (_redis?.isReady) return _redis;

  if (_redisConnecting) return null;

  const url = process.env.REDIS_URL;
  if (!url) return null;

  _redisConnecting = true;
  try {
    const client = createClient({ url });
    client.on('error', (err) => {
      logger.warn('[tokenBucket] Redis error:', err.message);
      _redis = null;
      _redisConnecting = false;
    });
    await client.connect();
    _redis = client;
    logger.info('[tokenBucket] Redis connected:', url);
  } catch (err) {
    logger.warn('[tokenBucket] Redis unavailable, using in-process fallback:', err.message);
    _redis = null;
  } finally {
    _redisConnecting = false;
  }

  return _redis;
}

// ── In-process fallback limiter ────────────────────────────────────────────────

/**
 * Simple in-process token bucket used when Redis is unavailable.
 * NOT shared across instances — only suitable as a temporary fallback.
 *
 * Map key: "{clientId}:{endpointGroup}"
 * Map value: { tokens: number, lastRefill: number }
 */
const _fallbackBuckets = new Map();

/**
 * Consume one token from the in-process fallback bucket.
 *
 * @param {string} bucketKey    – "{clientId}:{endpointGroup}"
 * @param {number} rpm          – sustained requests per minute
 * @param {number} burst        – max burst size
 * @returns {{ allowed: boolean, remaining: number, retryAfter: number, reset: number }}
 */
function fallbackConsume(bucketKey, rpm, burst) {
  const now = Date.now();
  const refillRateMs = 60_000 / rpm; // ms per token
  const maxTokens = burst;

  let bucket = _fallbackBuckets.get(bucketKey);

  if (!bucket) {
    bucket = { tokens: maxTokens, lastRefill: now };
    _fallbackBuckets.set(bucketKey, bucket);
  }

  // Refill tokens proportional to elapsed time.
  const elapsed = now - bucket.lastRefill;
  const tokensToAdd = Math.floor(elapsed / refillRateMs);
  if (tokensToAdd > 0) {
    bucket.tokens = Math.min(maxTokens, bucket.tokens + tokensToAdd);
    bucket.lastRefill = now + (tokensToAdd * refillRateMs - elapsed);
    if (bucket.lastRefill > now) bucket.lastRefill = now;
  }

  const allowed = bucket.tokens >= 1;
  if (allowed) {
    bucket.tokens -= 1;
  }

  const remaining = bucket.tokens;
  const retryAfter = allowed ? 0 : Math.ceil(refillRateMs / 1000);
  const reset = Math.ceil((now + (maxTokens - remaining) * refillRateMs) / 1000);

  return { allowed, remaining, retryAfter, reset };
}

// ── CL.THROTTLE via Redis ──────────────────────────────────────────────────────

/**
 * Issue a CL.THROTTLE command and return a normalised result object.
 *
 * @param {import('redis').RedisClientType} redis
 * @param {string} key
 * @param {number} maxBurst        – burst - 1
 * @param {number} countPerPeriod  – rpm
 * @param {number} periodSeconds   – 60
 * @returns {Promise<{ allowed: boolean, limit: number, remaining: number, retryAfter: number, reset: number }>}
 */
async function clThrottle(redis, key, maxBurst, countPerPeriod, periodSeconds) {
  // CL.THROTTLE key max_burst count_per_period period_seconds [quantity]
  const result = await redis.sendCommand([
    'CL.THROTTLE',
    key,
    String(maxBurst),
    String(countPerPeriod),
    String(periodSeconds),
    '1',
  ]);

  // result: [allowed(0=yes,1=no), limit, remaining, retryAfter, resetAfter]
  const [limitedFlag, limit, remaining, retryAfterSecs, resetAfterSecs] = result;

  const now = Math.floor(Date.now() / 1000);
  return {
    allowed: limitedFlag === 0,
    limit: Number(limit),
    remaining: Number(remaining),
    retryAfter: Number(retryAfterSecs),
    reset: now + Number(resetAfterSecs),
  };
}

// ── Middleware ─────────────────────────────────────────────────────────────────

/**
 * Express middleware that enforces per-client, per-endpoint-group token bucket
 * rate limiting.
 *
 * Reads `req.rateContext` (populated by apiKeyAuthenticator) for:
 *   - clientId  {string}       – unique client identifier
 *   - tier      {string}       – tier name
 *   - rateLimit {number|null}  – per-key rpm override
 *
 * Sets `req.rateLimitState` for the downstream header writer:
 *   { limit, remaining, reset, tier }
 *
 * Returns 429 with `Retry-After` header when the bucket is exhausted.
 *
 * @type {import('express').RequestHandler}
 */
async function tokenBucketMiddleware(req, res, next) {
  try {
    // Ensure rateContext is present (apiKeyAuthenticator should always set it,
    // but guard defensively).
    const rateContext = req.rateContext ?? {
      clientId: 'unknown',
      tier: 'unauthenticated',
      rateLimit: null,
    };

    const { clientId, tier, rateLimit: overrideRpm } = rateContext;
    const endpointGroup = resolveEndpointGroup(req.path);
    const { rpm, burst } = getTierLimits(endpointGroup, tier, overrideRpm);

    // Compose the Redis key.
    const redisKey = `${RL_PREFIX}:${clientId}:${endpointGroup}`;

    // ── Try Redis CL.THROTTLE ──────────────────────────────────────────────
    let result = null;
    let usedFallback = false;

    try {
      const redis = await getRedisClient();

      if (redis?.isReady) {
        const maxBurst = burst - 1; // CL.THROTTLE max_burst = total extra tokens
        result = await clThrottle(redis, redisKey, maxBurst, rpm, 60);
      } else {
        usedFallback = true;
      }
    } catch (redisErr) {
      logger.warn('[tokenBucket] Redis CL.THROTTLE failed, using in-process fallback:', redisErr.message);
      usedFallback = true;
    }

    if (usedFallback) {
      const fallback = fallbackConsume(`${clientId}:${endpointGroup}`, rpm, burst);
      result = {
        allowed: fallback.allowed,
        limit: burst,
        remaining: fallback.remaining,
        retryAfter: fallback.retryAfter,
        reset: fallback.reset,
      };
    }

    // ── Attach rateLimitState for header writer ────────────────────────────
    req.rateLimitState = {
      limit: result.limit,
      remaining: result.remaining,
      reset: result.reset,
      tier,
    };

    // ── Enforce the limit ──────────────────────────────────────────────────
    if (!result.allowed) {
      res.set('Retry-After', String(result.retryAfter));
      return res.status(429).json({ error: 'Too many requests' });
    }

    return next();
  } catch (err) {
    logger.error('[tokenBucket] Unexpected error:', err);
    // Fail open — do not block the request on an unexpected internal error.
    return next();
  }
}

export { tokenBucketMiddleware, getRedisClient, fallbackConsume, clThrottle };
