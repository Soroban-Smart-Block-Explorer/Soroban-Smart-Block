/**
 * Admin Routes
 *
 * Mounts all admin-gated routes under `/api/admin/` using adminAuthMiddleware.
 * Also preserves the existing non-auth admin utility routes (health, doctor,
 * db-init, export) that were previously registered directly on the app.
 *
 * Admin API key management routes:
 *   GET    /api/admin/api-keys              — paginated list (no key_hash)
 *   POST   /api/admin/api-keys              — create key, return raw key once
 *   PATCH  /api/admin/api-keys/:id          — update metadata
 *   DELETE /api/admin/api-keys/:id          — soft delete
 *   POST   /api/admin/api-keys/:id/rotate   — rotate key
 *   GET    /api/admin/api-keys/:id/usage    — usage history
 *
 * Audit log routes:
 *   GET    /api/admin/audit-log             — filtered, paginated
 *   GET    /api/admin/audit-log/export      — CSV or JSON export
 */

import { Router } from 'express';
import { adminAuthMiddleware } from '../admin/adminAuth.js';
import {
  listKeys,
  createKey,
  updateKey,
  deleteKey,
  rotateKey,
  getKeyUsage,
} from '../admin/keyManager.js';
import { getRedisClient } from '../rateLimit/tokenBucket.js';
import { db, pool } from '../db.js';
import { runAllChecks } from '../doctor-lib.js';

// ── CSV helpers ───────────────────────────────────────────────────────────────

const AUDIT_LOG_COLUMNS = [
  'id',
  'timestamp',
  'api_key_id',
  'key_name',
  'tier',
  'ip',
  'method',
  'endpoint',
  'status_code',
  'response_time_ms',
  'rate_limit_remaining',
  'user_agent',
];

const EVENT_COLUMNS = [
  'seq',
  'contract_id',
  'function',
  'ledger',
  'tx_hash',
  'description',
  'cpu_instructions',
  'mem_bytes',
  'fee_charged',
  'is_clawback',
  'is_high_bloat_risk',
];

const CONTRACT_COLUMNS = [
  'id',
  'name',
  'description',
  'registered_by',
  'has_circuit_breaker',
  'is_paused',
  'is_rwa',
  'rwa_type',
  'created_at',
];

function rowsToCsv(rows, columns) {
  if (!rows.length) return columns.join(',') + '\n';
  const escape = (v) => {
    if (v == null) return '';
    const s = String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };
  const header = columns.join(',');
  const body = rows.map((r) => columns.map((c) => escape(r[c])).join(',')).join('\n');
  return header + '\n' + body + '\n';
}

// ── Router factory ────────────────────────────────────────────────────────────

/**
 * Returns an Express Router with all admin routes.
 * Also registers legacy utility routes on `app` directly (backwards compat).
 *
 * @param {import('express').Express} app  — the Express app instance
 * @returns {import('express').Router}
 */
export default function registerAdminRoutes(app) {
  // ── Legacy utility routes (no auth) ───────────────────────────────────────
  // /health is registered by api.js (comprehensive check via health.js). Skip it here.
  app.get('/api/doctor', async (_req, res) => {
    try {
      const checks = await runAllChecks();
      res.json(checks);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/setup/db-init', async (req, res) => {
    try {
      await db.init();
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/export/events', async (req, res) => {
    try {
      const format = req.query.format === 'json' ? 'json' : 'csv';
      const limit = Math.min(Number(req.query.limit) || 10000, 10000);
      const rows = await db.getEventsForExport({
        contract: req.query.contract,
        fn: req.query.fn,
        type: req.query.type,
        limit,
      });
      if (format === 'json') {
        res.setHeader('Content-Disposition', 'attachment; filename="events.json"');
        res.setHeader('Content-Type', 'application/json');
        return res.json(rows);
      }
      res.setHeader('Content-Disposition', 'attachment; filename="events.csv"');
      res.setHeader('Content-Type', 'text/csv');
      return res.send(rowsToCsv(rows, EVENT_COLUMNS));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/export/contracts', async (req, res) => {
    try {
      const format = req.query.format === 'json' ? 'json' : 'csv';
      const rows = await db.getContractsForExport();
      if (format === 'json') {
        res.setHeader('Content-Disposition', 'attachment; filename="contracts.json"');
        res.setHeader('Content-Type', 'application/json');
        return res.json(rows);
      }
      res.setHeader('Content-Disposition', 'attachment; filename="contracts.csv"');
      res.setHeader('Content-Type', 'text/csv');
      return res.send(rowsToCsv(rows, CONTRACT_COLUMNS));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Auth-gated admin router ────────────────────────────────────────────────
  const router = Router();

  // Apply admin auth to all routes on this router.
  router.use(adminAuthMiddleware);

  // ── GET /api/admin/api-keys ────────────────────────────────────────────────
  router.get('/api-keys', async (req, res) => {
    try {
      const page = Number(req.query.page) || 1;
      const limit = Number(req.query.limit) || 50;
      const result = await listKeys(page, limit);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/admin/api-keys ───────────────────────────────────────────────
  router.post('/api-keys', async (req, res) => {
    try {
      const result = await createKey(req.body);
      res.status(201).json(result);
    } catch (e) {
      const status = e.message.includes('required') || e.message.includes('must be') ? 400 : 500;
      res.status(status).json({ error: e.message });
    }
  });

  // ── PATCH /api/admin/api-keys/:id ─────────────────────────────────────────
  router.patch('/api-keys/:id', async (req, res) => {
    try {
      const record = await updateKey(req.params.id, req.body);
      res.json(record);
    } catch (e) {
      if (e.message.includes('not found')) return res.status(404).json({ error: e.message });
      const status = e.message.includes('required') || e.message.includes('must be') || e.message.includes('No updatable') ? 400 : 500;
      res.status(status).json({ error: e.message });
    }
  });

  // ── DELETE /api/admin/api-keys/:id ────────────────────────────────────────
  router.delete('/api-keys/:id', async (req, res) => {
    try {
      await deleteKey(req.params.id);
      res.status(204).end();
    } catch (e) {
      if (e.message.includes('not found')) return res.status(404).json({ error: e.message });
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/admin/api-keys/:id/rotate ───────────────────────────────────
  router.post('/api-keys/:id/rotate', async (req, res) => {
    try {
      const result = await rotateKey(req.params.id);
      res.json(result);
    } catch (e) {
      if (e.message.includes('not found')) return res.status(404).json({ error: e.message });
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/admin/api-keys/:id/usage ─────────────────────────────────────
  router.get('/api-keys/:id/usage', async (req, res) => {
    try {
      const days = Number(req.query.days) || 30;
      const usage = await getKeyUsage(req.params.id, days);
      res.json(usage);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/admin/audit-log ───────────────────────────────────────────────
  router.get('/audit-log', async (req, res) => {
    try {
      const {
        api_key_id,
        ip,
        endpoint,
        status_code,
        from: fromTs,
        to: toTs,
        limit: limitParam = '100',
        offset: offsetParam = '0',
      } = req.query;

      const limit = Math.min(Number(limitParam) || 100, 1000);
      const offset = Math.max(0, Number(offsetParam) || 0);

      const conditions = [];
      const params = [];

      if (api_key_id) {
        params.push(api_key_id);
        conditions.push(`api_key_id = $${params.length}`);
      }
      if (ip) {
        params.push(ip);
        conditions.push(`ip = $${params.length}::INET`);
      }
      if (endpoint) {
        params.push(endpoint);
        conditions.push(`endpoint = $${params.length}`);
      }
      if (status_code) {
        params.push(Number(status_code));
        conditions.push(`status_code = $${params.length}`);
      }
      if (fromTs) {
        params.push(fromTs);
        conditions.push(`timestamp >= $${params.length}`);
      }
      if (toTs) {
        params.push(toTs);
        conditions.push(`timestamp <= $${params.length}`);
      }

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      params.push(limit, offset);

      const { rows } = await pool.query(
        `SELECT id, timestamp, api_key_id, key_name, tier, ip, method,
                endpoint, status_code, response_time_ms, rate_limit_remaining, user_agent
         FROM api_audit_log
         ${where}
         ORDER BY timestamp DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );

      res.json({ data: rows, limit, offset });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/admin/audit-log/export ───────────────────────────────────────
  router.get('/audit-log/export', async (req, res) => {
    try {
      const {
        api_key_id,
        ip,
        endpoint,
        status_code,
        from: fromTs,
        to: toTs,
        limit: limitParam = '1000',
        offset: offsetParam = '0',
        format = 'json',
      } = req.query;

      const limit = Math.min(Number(limitParam) || 1000, 1000);
      const offset = Math.max(0, Number(offsetParam) || 0);

      const conditions = [];
      const params = [];

      if (api_key_id) {
        params.push(api_key_id);
        conditions.push(`api_key_id = $${params.length}`);
      }
      if (ip) {
        params.push(ip);
        conditions.push(`ip = $${params.length}::INET`);
      }
      if (endpoint) {
        params.push(endpoint);
        conditions.push(`endpoint = $${params.length}`);
      }
      if (status_code) {
        params.push(Number(status_code));
        conditions.push(`status_code = $${params.length}`);
      }
      if (fromTs) {
        params.push(fromTs);
        conditions.push(`timestamp >= $${params.length}`);
      }
      if (toTs) {
        params.push(toTs);
        conditions.push(`timestamp <= $${params.length}`);
      }

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      params.push(limit, offset);

      const { rows } = await pool.query(
        `SELECT id, timestamp, api_key_id, key_name, tier, ip, method,
                endpoint, status_code, response_time_ms, rate_limit_remaining, user_agent
         FROM api_audit_log
         ${where}
         ORDER BY timestamp DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );

      if (format === 'csv') {
        res.setHeader('Content-Disposition', 'attachment; filename="audit-log.csv"');
        res.setHeader('Content-Type', 'text/csv');
        return res.send(rowsToCsv(rows, AUDIT_LOG_COLUMNS));
      }

      res.setHeader('Content-Disposition', 'attachment; filename="audit-log.json"');
      res.setHeader('Content-Type', 'application/json');
      return res.json(rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/admin/analytics/rate-limit-hits ──────────────────────────────
  router.get('/analytics/rate-limit-hits', async (req, res) => {
    try {
      const minutes = Math.min(Number(req.query.minutes) || 60, 1440);
      const { rows } = await pool.query(
        `SELECT date_trunc('minute', timestamp) AS minute,
                COUNT(*) AS hits
         FROM api_audit_log
         WHERE status_code = 429
           AND timestamp >= NOW() - INTERVAL '1 minute' * $1
         GROUP BY 1
         ORDER BY 1 ASC`,
        [minutes],
      );
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/admin/analytics/top-users ────────────────────────────────────
  router.get('/analytics/top-users', async (req, res) => {
    try {
      const window = req.query.window === '7d' ? 7 : req.query.window === '24h' ? 1 : req.query.window === '1h' ? null : 1;
      let rows;
      if (window === null) {
        // 1 hour window — use audit log
        ({ rows } = await pool.query(
          `SELECT api_key_id, key_name, COUNT(*) AS total_requests
           FROM api_audit_log
           WHERE timestamp >= NOW() - INTERVAL '1 hour'
             AND api_key_id IS NOT NULL
           GROUP BY api_key_id, key_name
           ORDER BY total_requests DESC
           LIMIT 20`,
        ));
      } else {
        ({ rows } = await pool.query(
          `SELECT u.api_key_id, k.name AS key_name, SUM(u.total_requests) AS total_requests
           FROM api_key_usage_daily u
           JOIN api_keys k ON k.id = u.api_key_id
           WHERE u.date >= CURRENT_DATE - INTERVAL '1 day' * $1
           GROUP BY u.api_key_id, k.name
           ORDER BY total_requests DESC
           LIMIT 20`,
          [window],
        ));
      }
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/admin/analytics/violation-heatmap ────────────────────────────
  router.get('/analytics/violation-heatmap', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT EXTRACT(HOUR FROM timestamp)::INT AS hour,
                EXTRACT(DOW FROM timestamp)::INT AS day_of_week,
                COUNT(*) AS violations
         FROM api_audit_log
         WHERE status_code = 429
           AND timestamp >= NOW() - INTERVAL '30 days'
         GROUP BY 1, 2
         ORDER BY 2, 1`,
      );
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/admin/analytics/upgrade-recommendations ─────────────────────
  router.get('/analytics/upgrade-recommendations', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT k.id, k.name, k.tier,
                AVG(u.total_requests) AS avg_daily_requests,
                CASE k.tier
                  WHEN 'unauthenticated' THEN 60 * 60 * 24
                  WHEN 'free'            THEN 1000 * 60 * 24
                  WHEN 'pro'             THEN 10000 * 60 * 24
                  ELSE NULL
                END AS daily_tier_limit
         FROM api_key_usage_daily u
         JOIN api_keys k ON k.id = u.api_key_id
         WHERE u.date >= CURRENT_DATE - INTERVAL '7 days'
           AND k.revoked = FALSE
         GROUP BY k.id, k.name, k.tier
         HAVING
           CASE k.tier
             WHEN 'unauthenticated' THEN AVG(u.total_requests) > 0.8 * (60 * 60 * 24)
             WHEN 'free'            THEN AVG(u.total_requests) > 0.8 * (1000 * 60 * 24)
             WHEN 'pro'             THEN AVG(u.total_requests) > 0.8 * (10000 * 60 * 24)
             ELSE FALSE
           END
         ORDER BY avg_daily_requests DESC`,
      );
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Mount the router under /api/admin
  app.use('/api/admin', router);

  return router;
}
