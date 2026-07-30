/**
 * Audit Logger
 *
 * Provides non-blocking, batched audit logging to the `api_audit_log` table.
 *
 * Architecture:
 *   - auditLoggerMiddleware: Express middleware that records req/res metadata
 *     into an in-process queue on `res.on('finish')`. The HTTP response is
 *     sent before any DB write occurs.
 *   - createAuditLogEntry: Enqueues a single entry into the async queue.
 *   - startAuditFlush: Starts a setInterval loop that drains the queue every
 *     500 ms, batching up to MAX_BATCH_SIZE rows per INSERT for efficiency.
 *   - startAuditPartitionCron: Monthly cron job that pre-creates the next
 *     month's partition and drops partitions older than 90 days.
 */

import crypto from 'crypto';
import cron from 'node-cron';
import { pool } from '../db.js';

// ── Configuration ─────────────────────────────────────────────────────────────
const FLUSH_INTERVAL_MS = 500;
const MAX_BATCH_SIZE = 100;

// ── In-process queue ──────────────────────────────────────────────────────────
/** @type {object[]} */
const _queue = [];

// ── createAuditLogEntry ───────────────────────────────────────────────────────

/**
 * Add one audit log entry to the in-process async queue.
 * Returns immediately — does not await any DB write.
 *
 * @param {object} entry
 */
function createAuditLogEntry(entry) {
  _queue.push(entry);
}

// ── Flush loop ────────────────────────────────────────────────────────────────

/**
 * Drain up to MAX_BATCH_SIZE entries from the queue and INSERT them into
 * api_audit_log. Called by setInterval every FLUSH_INTERVAL_MS ms.
 */
async function _flushQueue() {
  if (_queue.length === 0) return;

  const batch = _queue.splice(0, MAX_BATCH_SIZE);
  if (batch.length === 0) return;

  try {
    // Build a multi-row VALUES clause.
    const valuePlaceholders = batch.map((_, i) => {
      const base = i * 12;
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::INET, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12})`;
    });

    const params = batch.flatMap((e) => [
      e.timestamp ?? new Date(),
      e.api_key_id ?? null,
      e.key_name ?? null,
      e.tier ?? 'unauthenticated',
      e.ip ?? '0.0.0.0',
      e.method ?? 'GET',
      e.endpoint ?? '/',
      e.status_code ?? 200,
      e.response_time_ms ?? 0,
      e.rate_limit_remaining ?? null,
      e.user_agent ?? null,
      e.request_body_hash ?? null,
    ]);

    await pool.query(
      `INSERT INTO api_audit_log
         (timestamp, api_key_id, key_name, tier, ip, method, endpoint,
          status_code, response_time_ms, rate_limit_remaining, user_agent,
          request_body_hash)
       VALUES ${valuePlaceholders.join(', ')}`,
      params,
    );
  } catch (err) {
    console.error('[auditLogger] Batch INSERT failed:', err.message);
    // Re-queue the batch so it is retried on the next flush cycle.
    // Prepend so ordering is roughly preserved.
    _queue.unshift(...batch);
  }
}

/**
 * Start the periodic flush loop. Only called by the indexer daemon
 * (src/index.js) — importing this module for the middleware/entry-queue
 * functions must not have the side effect of scheduling DB writes.
 *
 * @returns {NodeJS.Timeout}
 */
function startAuditFlush() {
  return setInterval(() => {
    _flushQueue().catch((err) => {
      console.error('[auditLogger] Flush interval error:', err.message);
    });
  }, FLUSH_INTERVAL_MS);
}

// ── auditLoggerMiddleware ─────────────────────────────────────────────────────

/**
 * Express middleware that queues an audit log entry when the response finishes.
 *
 * Reads:
 *   - req.rateContext   — { keyId, keyName, tier }  (set by apiKeyAuthenticator)
 *   - req.rateLimitState — { remaining }             (set by tokenBucketMiddleware)
 *   - req._startTime    — set by this middleware at request start
 *
 * @type {import('express').RequestHandler}
 */
function auditLoggerMiddleware(req, res, next) {
  req._startTime = Date.now();

  res.on('finish', () => {
    try {
      const forwarded = req.headers['x-forwarded-for'];
      const ip = forwarded
        ? String(forwarded).split(',')[0].trim()
        : req.socket?.remoteAddress ?? '0.0.0.0';

      let request_body_hash = null;
      if (req.body && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        try {
          const bodyStr = JSON.stringify(req.body);
          request_body_hash = crypto.createHash('sha256').update(bodyStr).digest('hex');
        } catch {
          // Non-serializable body — leave hash as null
        }
      }

      createAuditLogEntry({
        timestamp: new Date(),
        api_key_id: req.rateContext?.keyId ?? null,
        key_name: req.rateContext?.keyName ?? null,
        tier: req.rateContext?.tier ?? 'unauthenticated',
        ip,
        method: req.method,
        endpoint: req.path,
        status_code: res.statusCode,
        response_time_ms: Date.now() - req._startTime,
        rate_limit_remaining: req.rateLimitState?.remaining ?? null,
        user_agent: req.headers['user-agent'] ?? null,
        request_body_hash,
      });
    } catch (err) {
      // Never let audit logging affect the request lifecycle.
      console.error('[auditLogger] Failed to enqueue entry:', err.message);
    }
  });

  return next();
}

// ── startAuditPartitionCron ───────────────────────────────────────────────────

/**
 * Start a monthly cron job (runs on the 1st of each month at 01:00 UTC) that:
 *   1. Creates the next month's partition if it does not already exist.
 *   2. Drops partitions older than 90 days (free tier retention window).
 *
 * @returns {cron.ScheduledTask}
 */
function startAuditPartitionCron() {
  return cron.schedule('0 1 1 * *', async () => {
    try {
      const now = new Date();

      // Create partition for next month.
      const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
      const afterNextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 1));

      const partitionName = _partitionName(nextMonth);
      const fromStr = nextMonth.toISOString().slice(0, 10);
      const toStr = afterNextMonth.toISOString().slice(0, 10);

      try {
        await pool.query(
          `CREATE TABLE IF NOT EXISTS ${partitionName}
           PARTITION OF api_audit_log
           FOR VALUES FROM ('${fromStr}') TO ('${toStr}')`,
        );
        console.log(`[auditLogger] Created partition ${partitionName} (${fromStr} – ${toStr})`);
      } catch (createErr) {
        console.error(`[auditLogger] Failed to create partition ${partitionName}:`, createErr.message);
      }

      // Drop partitions older than 90 days.
      const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 90));

      // List existing partitions by querying pg_inherits.
      const { rows } = await pool.query(
        `SELECT c.relname AS partition_name
         FROM pg_inherits i
         JOIN pg_class p ON p.oid = i.inhparent
         JOIN pg_class c ON c.oid = i.inhrelid
         WHERE p.relname = 'api_audit_log'`,
      );

      for (const { partition_name } of rows) {
        const partDate = _parsePartitionDate(partition_name);
        if (partDate && partDate < cutoff) {
          try {
            await pool.query(`DROP TABLE IF EXISTS ${partition_name}`);
            console.log(`[auditLogger] Dropped old partition ${partition_name}`);
          } catch (dropErr) {
            console.error(`[auditLogger] Failed to drop partition ${partition_name}:`, dropErr.message);
          }
        }
      }
    } catch (err) {
      console.error('[auditLogger] Partition cron error:', err.message);
    }
  });
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Build a partition table name like `api_audit_log_y2025m06` from a Date.
 * @param {Date} date
 * @returns {string}
 */
function _partitionName(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `api_audit_log_y${year}m${month}`;
}

/**
 * Parse the year+month from a partition name like `api_audit_log_y2025m06`.
 * Returns the first day of that month as a Date, or null if unparseable.
 * @param {string} name
 * @returns {Date|null}
 */
function _parsePartitionDate(name) {
  const match = name.match(/y(\d{4})m(\d{2})$/);
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
}

export { createAuditLogEntry, auditLoggerMiddleware, startAuditPartitionCron, startAuditFlush };
