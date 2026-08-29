import { logger } from "../logger.js";
/**
 * Usage Tracker
 *
 * Increments Redis counters for per-key daily metrics on each request and
 * periodically flushes them to the `api_key_usage_daily` PostgreSQL table.
 *
 * Redis counter keys (all are plain string counters):
 *   usage:{keyId}:{date}:total_requests
 *   usage:{keyId}:{date}:data_transfer_bytes
 *   usage:{keyId}:{date}:rate_limit_hits
 *   usage:{keyId}:{date}:endpoint:{endpointGroup}
 *
 * Two cron jobs:
 *   - Every minute: flush Redis counters → upsert into api_key_usage_daily
 *   - Nightly:      delete rows older than the tier's retention window
 *
 * Retention periods (matching the design document):
 *   free:        7 days
 *   pro:         90 days
 *   enterprise:  3 years (1095 days)
 */

import cron from 'node-cron';
import { getRedisClient } from '../rateLimit/tokenBucket.js';
import { pool } from '../db.js';
import { resolveEndpointGroup } from '../rateLimit/endpointGroups.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns today's date as YYYY-MM-DD in UTC.
 * @returns {string}
 */
function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

// ── recordRequest ─────────────────────────────────────────────────────────────

/**
 * Increment Redis usage counters for one request.
 *
 * Fire-and-forget — errors are logged but never propagate to the caller.
 *
 * @param {string|null} keyId         — api_keys.id (UUID), or null for unauthed
 * @param {string}      endpoint      — req.path
 * @param {number}      responseBytes — response body byte count
 * @param {boolean}     isRateLimited — whether the request was rate-limited (429)
 */
async function recordRequest(keyId, endpoint, responseBytes, isRateLimited) {
  if (!keyId) return; // Do not track unauthenticated requests in per-key counters.

  try {
    const redis = await getRedisClient();
    if (!redis?.isReady) return;

    const date = todayUtc();
    const endpointGroup = resolveEndpointGroup(endpoint);
    const base = `usage:${keyId}:${date}`;

    // Use a pipeline for efficiency.
    const pipeline = redis.multi();
    pipeline.incr(`${base}:total_requests`);
    pipeline.incrBy(`${base}:data_transfer_bytes`, Math.max(0, Math.floor(responseBytes) || 0));
    if (isRateLimited) {
      pipeline.incr(`${base}:rate_limit_hits`);
    }
    pipeline.incr(`${base}:endpoint:${endpointGroup}`);
    await pipeline.exec();
  } catch (err) {
    logger.warn('[usageTracker] Failed to record request in Redis:', err.message);
  }
}

// ── startUsageFlushCron ───────────────────────────────────────────────────────

/**
 * Start a cron job that runs every minute, scanning Redis for usage:{*} keys,
 * aggregating them per (keyId, date), upserting into api_key_usage_daily,
 * then deleting the processed Redis keys.
 *
 * @returns {cron.ScheduledTask}
 */
function startUsageFlushCron() {
  return cron.schedule('* * * * *', async () => {
    try {
      const redis = await getRedisClient();
      if (!redis?.isReady) return;

      // Scan for all usage keys. SCAN is preferred over KEYS in production.
      const usageKeys = [];
      let cursor = 0;
      do {
        const result = await redis.scan(cursor, { MATCH: 'usage:*', COUNT: 200 });
        cursor = result.cursor;
        usageKeys.push(...result.keys);
      } while (cursor !== 0);

      if (usageKeys.length === 0) return;

      // Group keys by (keyId, date).
      // Key format: usage:{keyId}:{date}:{metric} or usage:{keyId}:{date}:endpoint:{group}
      const buckets = new Map(); // key: `${keyId}:${date}` → { keyId, date, keys: [] }

      for (const k of usageKeys) {
        const parts = k.split(':');
        // parts[0] = 'usage', parts[1] = keyId, parts[2] = date, parts[3+] = metric
        if (parts.length < 4) continue;
        const keyId = parts[1];
        const date = parts[2];
        const bucketKey = `${keyId}:${date}`;

        if (!buckets.has(bucketKey)) {
          buckets.set(bucketKey, { keyId, date, keys: [] });
        }
        buckets.get(bucketKey).keys.push(k);
      }

      // For each bucket, read all counters and upsert.
      for (const [, bucket] of buckets) {
        const { keyId, date, keys } = bucket;

        // Fetch all values in one pipeline.
        const pipeline = redis.multi();
        for (const k of keys) pipeline.get(k);
        const values = await pipeline.exec();

        const keyValues = Object.fromEntries(keys.map((k, i) => [k, Number(values[i]) || 0]));

        const base = `usage:${keyId}:${date}`;
        const totalRequests = keyValues[`${base}:total_requests`] || 0;
        const dataTransferBytes = keyValues[`${base}:data_transfer_bytes`] || 0;
        const rateLimitHits = keyValues[`${base}:rate_limit_hits`] || 0;
        const datTransferMb = dataTransferBytes / (1024 * 1024);

        // Collect endpoint distribution.
        const endpointDist = {};
        for (const k of keys) {
          const match = k.match(/^usage:[^:]+:[^:]+:endpoint:(.+)$/);
          if (match) {
            endpointDist[match[1]] = keyValues[k] || 0;
          }
        }

        try {
          await pool.query(
            `INSERT INTO api_key_usage_daily
               (api_key_id, date, total_requests, endpoint_distribution,
                data_transfer_mb, rate_limit_hits)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (api_key_id, date) DO UPDATE SET
               total_requests        = api_key_usage_daily.total_requests + EXCLUDED.total_requests,
               endpoint_distribution = COALESCE(api_key_usage_daily.endpoint_distribution, '{}'::jsonb)
                                       || EXCLUDED.endpoint_distribution,
               data_transfer_mb      = api_key_usage_daily.data_transfer_mb + EXCLUDED.data_transfer_mb,
               rate_limit_hits       = api_key_usage_daily.rate_limit_hits + EXCLUDED.rate_limit_hits`,
            [keyId, date, totalRequests, JSON.stringify(endpointDist), datTransferMb, rateLimitHits],
          );

          // Only delete Redis keys after a successful DB write.
          if (keys.length > 0) {
            await redis.del(keys);
          }
        } catch (dbErr) {
          logger.error(`[usageTracker] DB upsert failed for key ${keyId}/${date}:`, dbErr.message);
          // Leave Redis keys intact so the next run can retry.
        }
      }
    } catch (err) {
      logger.error('[usageTracker] Flush cron error:', err.message);
    }
  });
}

// ── startRetentionCleanupCron ─────────────────────────────────────────────────

/**
 * Start a nightly cron job (runs at 02:00 UTC) that deletes usage rows older
 * than the tier's retention window.
 *
 * Retention windows:
 *   free:        7 days
 *   pro:         90 days
 *   enterprise:  1095 days (3 years)
 *
 * Unauthenticated tier records are cleaned up with the free policy.
 *
 * @returns {cron.ScheduledTask}
 */
function startRetentionCleanupCron() {
  return cron.schedule('0 2 * * *', async () => {
    try {
      const retentionPolicies = [
        { tier: 'free',         days: 7 },
        { tier: 'unauthenticated', days: 7 },
        { tier: 'pro',          days: 90 },
        { tier: 'enterprise',   days: 1095 },
      ];

      for (const { tier, days } of retentionPolicies) {
        try {
          const { rowCount } = await pool.query(
            `DELETE FROM api_key_usage_daily
             WHERE api_key_id IN (
               SELECT id FROM api_keys WHERE tier = $1
             )
             AND date < NOW() - INTERVAL '1 day' * $2`,
            [tier, days],
          );
          if (rowCount > 0) {
            logger.info(`[usageTracker] Retention cleanup: deleted ${rowCount} rows for tier=${tier} (>${days}d)`);
          }
        } catch (tierErr) {
          logger.error(`[usageTracker] Retention cleanup failed for tier ${tier}:`, tierErr.message);
        }
      }
    } catch (err) {
      logger.error('[usageTracker] Retention cron error:', err.message);
    }
  });
}

export { recordRequest, startUsageFlushCron, startRetentionCleanupCron };
