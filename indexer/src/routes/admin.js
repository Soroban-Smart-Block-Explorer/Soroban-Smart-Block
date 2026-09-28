/**
 * Admin Routes
 *
 * Mounts all admin-gated routes under `/api/admin/` using adminAuthMiddleware.
 *
 * The legacy no-auth utility routes (`/api/doctor`, `/api/setup/db-init`,
 * `/api/export/*`) that used to be registered here directly on `app` were
 * removed (see issue: unauthenticated db-init). `api.js` already defines
 * `/api/setup/doctor` and `/api/setup/db-init` behind `blockInProduction`,
 * and the export routes — registering unguarded duplicates here shadowed
 * those guards because this router is mounted first. Do not re-add
 * unauthenticated routes to this file.
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

import { Router } from "express";
import { adminAuthMiddleware } from "../admin/adminAuth.js";
import { listKeys, createKey, updateKey, deleteKey, rotateKey, getKeyUsage } from "../admin/keyManager.js";
import { db, pool } from "../db.js";
import { getActiveAlerts, resolveAlert } from "../alertManager.js";
import { createSigningSecret } from "../auth/requestSigning.js";
import {
  decodeCursor,
  hashFilters,
  formatPageResponse,
  InvalidCursorError,
  CursorFilterMismatchError,
} from "../cursor.js";
import config from "../config.js";
import { getEventLineage } from "../lineage.js";
import { getItems as dlqGetItems, resolve as dlqResolve, requeueByErrorClass, DLQ_STATES } from "../deadLetterQueue.js";
// Note: getRedisClient (rateLimit/tokenBucket.js) and runAllChecks
// (doctor-lib.js) were imported here but never called anywhere in this
// file — dead imports left over from the removed legacy /api/doctor route
// (see comment below). Not re-added.

// ── CSV helpers ───────────────────────────────────────────────────────────────

const AUDIT_LOG_COLUMNS = [
  "id",
  "timestamp",
  "api_key_id",
  "key_name",
  "tier",
  "ip",
  "method",
  "endpoint",
  "status_code",
  "response_time_ms",
  "rate_limit_remaining",
  "user_agent",
  "request_body_hash",
];

function decodeAuditCursor(value) {
  try {
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!cursor.timestamp || !Number.isFinite(Date.parse(cursor.timestamp)) || !Number.isSafeInteger(Number(cursor.id)) || Number(cursor.id) < 1) {
      throw new Error();
    }
    return cursor;
  } catch {
    throw new Error('Invalid audit-log cursor');
  }
}

function encodeAuditCursor(row) {
  return Buffer.from(JSON.stringify({ timestamp: row.timestamp, id: row.id })).toString('base64url');
}

// Note: EVENT_COLUMNS/CONTRACT_COLUMNS were only used by the removed legacy
// /api/export/events and /api/export/contracts routes (see comment below)
// and are dropped along with them.

async function runIntegrityChecks() {
  const failed = [];

  const { rows: gapRows } = await pool.query(
    `SELECT COUNT(*)::int AS gap_count
     FROM (
       SELECT seq,
              LAG(seq) OVER (ORDER BY seq) AS previous_seq
       FROM events
     ) AS ordered
     WHERE seq - previous_seq > 1`,
  );
  if (Number(gapRows[0]?.gap_count ?? 0) > 0) {
    failed.push({ check: "seq_gap", details: { gap_count: Number(gapRows[0].gap_count) } });
  }

  const { rows: ledgerOrderRows } = await pool.query(
    `SELECT COUNT(*)::int AS non_monotonic_count
     FROM (
       SELECT seq,
              ledger,
              LAG(ledger) OVER (ORDER BY seq) AS previous_ledger
       FROM events
     ) AS ordered
     WHERE previous_ledger IS NOT NULL
       AND ledger < previous_ledger`,
  );
  if (Number(ledgerOrderRows[0]?.non_monotonic_count ?? 0) > 0) {
    failed.push({
      check: "ledger_monotonicity",
      details: { non_monotonic_count: Number(ledgerOrderRows[0].non_monotonic_count) },
    });
  }

  const { rows: maxLedgerRows } = await pool.query(`SELECT COALESCE(MAX(ledger), 0)::bigint AS max_ledger FROM events`);
  const { rows: lastIndexedRows } = await pool.query(
    `SELECT COALESCE((SELECT value FROM daemon_state WHERE key = 'last_indexed_ledger'), '0') AS value`,
  );
  const maxLedger = Number(maxLedgerRows[0]?.max_ledger ?? 0);
  const lastIndexedLedger = Number(lastIndexedRows[0]?.value ?? 0);
  if (lastIndexedLedger !== maxLedger) {
    failed.push({ check: "last_indexed_ledger", details: { expected: maxLedger, actual: lastIndexedLedger } });
  }

  const { rows: txRangeRows } = await pool.query(
    `SELECT COALESCE(MIN(ledger), 0)::bigint AS min_ledger,
            COALESCE(MAX(ledger), 0)::bigint AS max_ledger
     FROM events`,
  );
  const minLedger = Number(txRangeRows[0]?.min_ledger ?? 0);
  const maxLedgerForTx = Number(txRangeRows[0]?.max_ledger ?? 0);
  const { rows: hashCountRows } = await pool.query(
    `SELECT COUNT(*)::int AS ledger_hash_count
     FROM ledger_hashes
     WHERE ledger >= $1
       AND ledger <= $2`,
    [minLedger, maxLedgerForTx],
  );
  const ledgerHashCount = Number(hashCountRows[0]?.ledger_hash_count ?? 0);
  if (ledgerHashCount > 0 && maxLedgerForTx > 0) {
    const { rows: txCountRows } = await pool.query(
      `SELECT COUNT(DISTINCT tx_hash)::int AS distinct_tx_hashes
       FROM events
       WHERE tx_hash IS NOT NULL
         AND ledger >= $1
         AND ledger <= $2`,
      [minLedger, maxLedgerForTx],
    );
    const distinctTxHashes = Number(txCountRows[0]?.distinct_tx_hashes ?? 0);
    if (distinctTxHashes !== ledgerHashCount) {
      failed.push({
        check: "ledger_hash_count",
        details: { distinct_tx_hashes: distinctTxHashes, ledger_hash_count: ledgerHashCount },
      });
    }
  }

  return failed.length ? { ok: false, failed } : { ok: true };
}

function rowsToCsv(rows, columns) {
  if (!rows.length) return columns.join(",") + "\n";
  const escape = (v) => {
    if (v == null) return "";
    const s = String(v);
    return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = columns.join(",");
  const body = rows.map((r) => columns.map((c) => escape(r[c])).join(",")).join("\n");
  return header + "\n" + body + "\n";
}

export { runIntegrityChecks };

// ── Router factory ────────────────────────────────────────────────────────────

/**
 * Returns an Express Router with all admin routes, mounted under /api/admin
 * and gated by adminAuthMiddleware.
 *
 * @param {import('express').Express} app  — the Express app instance
 * @returns {import('express').Router}
 */
export default function registerAdminRoutes(app) {
  // ── Auth-gated admin router ────────────────────────────────────────────────
  const router = Router();

  // Apply admin auth to all routes on this router.
  router.use(adminAuthMiddleware);

  // ── Runtime configuration (#894) ───────────────────────────────────────
  // View, apply (optimistic concurrency on version) and revert runtime
  // settings without a restart. Every request here is audit-logged by
  // auditLoggerMiddleware, and each version records author and comment.
  router.get('/runtime-config', async (_req, res) => {
    try {
      res.json({ current: getRuntimeConfigCurrent(), history: await listRuntimeConfigHistory(pool) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/runtime-config', async (req, res) => {
    const { config, expectedVersion, comment } = req.body ?? {};
    const author = req.admin?.id ?? req.admin?.username ?? 'admin';
    try {
      const previousVersion = getRuntimeConfigCurrent().version;
      const baseline = await sampleHealth();
      const applied = await applyRuntimeConfig(pool, { config, expectedVersion, author, comment });
      res.json({ applied, guardrail: 'watching for 5 minutes' });

      // Auto-rollback if the change degrades error rate or lag.
      if (previousVersion > 0) {
        watchGuardrail({
          sample: sampleHealth,
          baseline,
          revert: () =>
            revertRuntimeConfig(pool, previousVersion, { author: 'guardrail', comment: `auto-revert of version ${applied.version}` }),
          alert: (message) => fireAlert(ALERT_CONDITIONS.RUNTIME_CONFIG_REVERTED, message),
        }).catch((err) => console.error('[runtimeConfig] guardrail failed:', err.message));
      }
    } catch (err) {
      res.status(err instanceof RuntimeConfigError ? err.status : 500).json({ error: err.message });
    }
  });

  router.post('/runtime-config/revert/:version', async (req, res) => {
    try {
      const reverted = await revertRuntimeConfig(pool, Number(req.params.version), {
        author: req.admin?.id ?? req.admin?.username ?? 'admin',
        comment: req.body?.comment,
      });
      res.json({ applied: reverted });
    } catch (err) {
      res.status(err instanceof RuntimeConfigError ? err.status : 500).json({ error: err.message });
    }
  });

  // ── GET /api/admin/integrity ─────────────────────────────────────────────
  // ── GET /api/admin/events/:seq/lineage ─────────────────────────────────────
  // Full provenance chain for one event (#945).
  router.get("/events/:seq/lineage", async (req, res) => {
    try {
      const seq = Number(req.params.seq);
      if (!Number.isSafeInteger(seq) || seq < 1) return res.status(400).json({ error: "Invalid event id" });
      const lineage = await getEventLineage(seq, { full: true });
      if (!lineage) return res.status(404).json({ error: "Not found" });
      res.json(lineage);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/integrity", async (_req, res) => {
    try {
      const result = await runIntegrityChecks();
      if (result.ok) {
        return res.json({ ok: true });
      }
      return res.json(result);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // ── Abuse scoring (#931): flagged principals with evidence + manual override ──
  router.get("/abuse", (_req, res) => {
    res.json({ shadowMode: isShadowMode(), flagged: listFlagged() });
  });

  router.post("/abuse/:principal/override", (req, res) => {
    const hours = Number(req.body?.hours ?? 24);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 30) {
      return res.status(400).json({ error: "hours must be between 0 and 720" });
    }
    overridePrincipal(req.params.principal, hours);
    res.json({ principal: req.params.principal, overriddenForHours: hours });
  });

  // ── POST /api/admin/alerts/:condition/resolve ─────────────────────────────
  router.post("/alerts/:condition/resolve", (req, res) => {
    const { condition } = req.params;
    const resolved = getActiveAlerts().some((alert) => alert.condition === condition);

    resolveAlert(condition);
    res.json({ condition, resolved });
  });

  router.get('/jobs', async (req, res) => {
    try { res.json({ data: await listJobs({ status: req.query.status, limit: req.query.limit }) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  router.post('/jobs', async (req, res) => {
    try { res.status(201).json(await enqueueJob(req.body)); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  router.post('/jobs/:id/cancel', async (req, res) => {
    try { await cancelJob(req.params.id); res.json({ ok: true, id: req.params.id }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── GET /api/admin/api-keys ────────────────────────────────────────────────
  router.get("/api-keys", async (req, res) => {
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
  router.post("/api-keys", async (req, res) => {
    try {
      const result = await createKey(req.body, { allowAdmin: true });
      res.status(201).json(result);
    } catch (e) {
      const status = e.message.includes("required") || e.message.includes("must be") ? 400 : 500;
      res.status(status).json({ error: e.message });
    }
  });

  // ── PATCH /api/admin/api-keys/:id ─────────────────────────────────────────
  router.patch("/api-keys/:id", async (req, res) => {
    try {
      const record = await updateKey(req.params.id, req.body);
      res.json(record);
    } catch (e) {
      if (e.message.includes("not found")) return res.status(404).json({ error: e.message });
      const status =
        e.message.includes("required") || e.message.includes("must be") || e.message.includes("No updatable")
          ? 400
          : 500;
      res.status(status).json({ error: e.message });
    }
  });

  // ── DELETE /api/admin/api-keys/:id ────────────────────────────────────────
  router.delete("/api-keys/:id", async (req, res) => {
    try {
      await deleteKey(req.params.id);
      res.status(204).end();
    } catch (e) {
      if (e.message.includes("not found")) return res.status(404).json({ error: e.message });
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/admin/api-keys/:id/rotate ───────────────────────────────────
  router.post("/api-keys/:id/rotate", async (req, res) => {
    try {
      const result = await rotateKey(req.params.id);
      res.json(result);
    } catch (e) {
      if (e.message.includes("not found")) return res.status(404).json({ error: e.message });
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/admin/api-keys/:id/signing-secret (issue #852) ──────────────
  // Issues a new HMAC signing secret, shown exactly once. The previous secret
  // stays valid alongside it (rotation overlap); anything older is revoked.
  router.post("/api-keys/:id/signing-secret", async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT id FROM api_keys WHERE id::text = $1`, [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: `API key ${req.params.id} not found` });
      const signing_secret = await createSigningSecret(req.params.id);
      res.status(201).json({ key_id: req.params.id, signing_secret });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/admin/api-keys/:id/usage ─────────────────────────────────────
  router.get("/api-keys/:id/usage", async (req, res) => {
    try {
      const usage = await getKeyUsage(req.params.id);
      res.json(usage);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/admin/audit-log ───────────────────────────────────────────────
  router.get("/audit-log", async (req, res) => {
    try {
      const {
        api_key_id,
        ip,
        endpoint,
        status_code,
        from: fromTs,
        to: toTs,
        limit: limitParam = "100",
        offset: offsetParam,
        page: pageParam,
        cursor,
        after,
        before,
      } = req.query;

      const hasLegacy = offsetParam !== undefined || pageParam !== undefined;
      if (hasLegacy) {
        if (!config.PAGINATION_LEGACY_OFFSET) {
          return res.status(400).json({
            error: "offset_pagination_deprecated",
            message:
              "OFFSET/page pagination is deprecated and disabled. Use keyset cursor pagination (cursor/after/before).",
          });
        }
        res.setHeader("Deprecation", "true");
        res.setHeader("Link", '</docs/api/pagination>; rel="deprecation"');
      }

      const limit = Math.min(Number(limitParam) || 100, 1000);
      const filterHash = hashFilters({ api_key_id, ip, endpoint, status_code, from: fromTs, to: toTs });

      let isBackward = false;
      let anchorTs = null;
      let anchorId = null;
      let hasAnchor = false;

      if (before) {
        const decoded = decodeCursor(before, filterHash, config.CURSOR_SIGNING_SECRET);
        anchorTs = decoded.tuple[0];
        anchorId = decoded.tuple[1];
        isBackward = true;
        hasAnchor = true;
      } else if (after || cursor) {
        const token = after || cursor;
        const decoded = decodeCursor(token, filterHash, config.CURSOR_SIGNING_SECRET);
        anchorTs = decoded.tuple[0];
        anchorId = decoded.tuple[1];
        isBackward = decoded.direction === "backward";
        hasAnchor = true;
      }

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
      if (after) {
        const cursor = decodeAuditCursor(String(after));
        params.push(cursor.timestamp, cursor.id);
        conditions.push(`(timestamp, id) < ($${params.length - 1}::timestamptz, $${params.length}::bigint)`);
      }

      // If legacy offset request without cursor
      if (!hasAnchor && hasLegacy) {
        const offset =
          offsetParam !== undefined
            ? Math.max(0, Number(offsetParam) || 0)
            : (Math.max(1, Number(pageParam) || 1) - 1) * limit;
        const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
        params.push(limit, offset);
        const { rows } = await pool.query(
          `SELECT id, timestamp, api_key_id, key_name, tier, ip, method,
                  endpoint, status_code, response_time_ms, rate_limit_remaining,
                  user_agent, request_body_hash
           FROM api_audit_log
           ${where}
           ORDER BY timestamp DESC, id DESC
           LIMIT $${params.length - 1} OFFSET $${params.length}`,
          params,
        );
        return res.json({ data: rows, limit, offset });
      }

      if (anchorTs !== null && anchorId !== null) {
        params.push(anchorTs, anchorId);
        const p1 = params.length - 1;
        const p2 = params.length;
        if (isBackward) {
          conditions.push(`(timestamp, id) > ($${p1}::timestamptz, $${p2}::bigint)`);
        } else {
          conditions.push(`(timestamp, id) < ($${p1}::timestamptz, $${p2}::bigint)`);
        }
      }

      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      params.push(limit + 1);

      const orderDirection = isBackward ? "ASC" : "DESC";
      const { rows } = await pool.query(
        `SELECT id, timestamp, api_key_id, key_name, tier, ip, method,
                endpoint, status_code, response_time_ms, rate_limit_remaining,
                user_agent, request_body_hash
         FROM api_audit_log
         ${where}
         ORDER BY timestamp ${orderDirection}, id ${orderDirection}
         LIMIT $${params.length}`,
        params,
      );

      const hasExtraRow = rows.length > limit;
      const formatted = formatPageResponse({
        data: rows,
        limit,
        hasExtraRow,
        isBackward,
        hasAnchor,
        extractTuple: (r) => [r.timestamp instanceof Date ? r.timestamp.toISOString() : r.timestamp, Number(r.id)],
        filterHash,
        secret: config.CURSOR_SIGNING_SECRET,
      });

      res.json({
        data: formatted.data,
        page_info: formatted.page_info,
        next_cursor: formatted.next_cursor,
        limit,
      });
    } catch (e) {
      if (e instanceof InvalidCursorError || e?.code === "invalid_cursor") {
        return res.status(400).json({ error: "invalid_cursor", message: e.message });
      }
      if (e instanceof CursorFilterMismatchError || e?.code === "cursor_filter_mismatch") {
        return res.status(400).json({ error: "cursor_filter_mismatch", message: e.message });
      }
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/admin/audit-log/export ───────────────────────────────────────
  router.get("/audit-log/export", async (req, res) => {
    try {
      const {
        api_key_id,
        ip,
        endpoint,
        status_code,
        from: fromTs,
        to: toTs,
        limit: limitParam = "1000",
        offset: offsetParam,
        page: pageParam,
        cursor,
        after,
        format = "json",
      } = req.query;

      const hasLegacy = offsetParam !== undefined || pageParam !== undefined;
      if (hasLegacy) {
        if (!config.PAGINATION_LEGACY_OFFSET) {
          return res.status(400).json({
            error: "offset_pagination_deprecated",
            message:
              "OFFSET/page pagination is deprecated and disabled. Use keyset cursor pagination (cursor/after/before).",
          });
        }
        res.setHeader("Deprecation", "true");
        res.setHeader("Link", '</docs/api/pagination>; rel="deprecation"');
      }

      const limit = Math.min(Number(limitParam) || 1000, 1000);
      const filterHash = hashFilters({ api_key_id, ip, endpoint, status_code, from: fromTs, to: toTs });

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
      if (after) {
        const cursor = decodeAuditCursor(String(after));
        params.push(cursor.timestamp, cursor.id);
        conditions.push(`(timestamp, id) < ($${params.length - 1}::timestamptz, $${params.length}::bigint)`);
      }

      if (after || cursor) {
        const token = after || cursor;
        const decoded = decodeCursor(token, filterHash, config.CURSOR_SIGNING_SECRET);
        params.push(decoded.tuple[0], decoded.tuple[1]);
        const p1 = params.length - 1;
        const p2 = params.length;
        conditions.push(`(timestamp, id) < ($${p1}::timestamptz, $${p2}::bigint)`);
      } else if (hasLegacy) {
        const offset =
          offsetParam !== undefined
            ? Math.max(0, Number(offsetParam) || 0)
            : (Math.max(1, Number(pageParam) || 1) - 1) * limit;
        params.push(limit, offset);
        const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
        const { rows } = await pool.query(
          `SELECT id, timestamp, api_key_id, key_name, tier, ip, method,
                  endpoint, status_code, response_time_ms, rate_limit_remaining,
                  user_agent, request_body_hash
           FROM api_audit_log
           ${where}
           ORDER BY timestamp DESC, id DESC
           LIMIT $${params.length - 1} OFFSET $${params.length}`,
          params,
        );

        if (format === "csv") {
          res.setHeader("Content-Disposition", 'attachment; filename="audit-log.csv"');
          res.setHeader("Content-Type", "text/csv");
          return res.send(rowsToCsv(rows, AUDIT_LOG_COLUMNS));
        }

        res.setHeader("Content-Disposition", 'attachment; filename="audit-log.json"');
        res.setHeader("Content-Type", "application/json");
        return res.json(rows);
      }

      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      params.push(limit);

      const { rows } = await pool.query(
        `SELECT id, timestamp, api_key_id, key_name, tier, ip, method,
                endpoint, status_code, response_time_ms, rate_limit_remaining,
                user_agent, request_body_hash
         FROM api_audit_log
         ${where}
         ORDER BY timestamp DESC, id DESC
         LIMIT $${params.length}`,
        params,
      );
      const hasMore = rows.length > limit;
      const data = hasMore ? rows.slice(0, limit) : rows;
      if (hasMore) res.setHeader('X-Next-Cursor', encodeAuditCursor(data.at(-1)));

      if (format === "csv") {
        res.setHeader("Content-Disposition", 'attachment; filename="audit-log.csv"');
        res.setHeader("Content-Type", "text/csv");
        return res.send(rowsToCsv(rows, AUDIT_LOG_COLUMNS));
      }

      res.setHeader("Content-Disposition", 'attachment; filename="audit-log.json"');
      res.setHeader("Content-Type", "application/json");
      return res.json(rows);
    } catch (e) {
      if (e instanceof InvalidCursorError || e?.code === "invalid_cursor") {
        return res.status(400).json({ error: "invalid_cursor", message: e.message });
      }
      if (e instanceof CursorFilterMismatchError || e?.code === "cursor_filter_mismatch") {
        return res.status(400).json({ error: "cursor_filter_mismatch", message: e.message });
      }
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/admin/analytics/rate-limit-hits ──────────────────────────────
  router.get("/analytics/rate-limit-hits", async (req, res) => {
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
  router.get("/analytics/top-users", async (req, res) => {
    try {
      const window =
        req.query.window === "7d" ? 7 : req.query.window === "24h" ? 1 : req.query.window === "1h" ? null : 1;
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
  router.get("/analytics/violation-heatmap", async (req, res) => {
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
  router.get("/analytics/upgrade-recommendations", async (req, res) => {
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

  // ── POST /api/admin/abi/import-github ────────────────────────────────────
  // Issue #520 — bulk ABI import from a GitHub repo.
  //
  // Accepts: { repo: 'owner/repo', path: 'contracts/', ref: 'main' }
  // Returns: { imported: N, skipped: M, errors: [...] }
  //
  // Rate-limited to 1 call per 10 minutes per repo (in-process Map — no Redis
  // dependency required). Files are validated against contractRegistry.schema.json.
  // Importing the same repo twice is idempotent — upsert only changed fields.
  {
    // Per-repo rate-limit state: repo → next-allowed-time (ms epoch)
    const importCooldowns = new Map();
    const IMPORT_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

    const GITHUB_API = "https://api.github.com";

    function githubHeaders() {
      const h = {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "SorobanBlockExplorer/1.0",
      };
      const token = process.env.GITHUB_TOKEN;
      if (token) h.Authorization = `Bearer ${token}`;
      return h;
    }

    /** Validate a parsed ABI JSON object against contractRegistry.schema.json rules. */
    function validateAbiEntry(entry) {
      if (!entry || typeof entry !== "object") return "entry must be an object";
      if (!entry.contractId || typeof entry.contractId !== "string") return "missing contractId";
      if (!/^C[A-Z2-7]{55}$/.test(entry.contractId)) return "contractId must be a 56-char C… strkey";
      if (!entry.name || typeof entry.name !== "string") return "missing name";
      if (entry.name.length > 100) return "name exceeds 100 chars";
      if (entry.description && entry.description.length > 500) return "description exceeds 500 chars";
      if (entry.functions !== undefined && !Array.isArray(entry.functions)) return "functions must be an array";
      return null; // valid
    }

    router.post("/abi/import-github", async (req, res) => {
      try {
        const { repo, path: repoPath = "contracts/", ref = "main" } = req.body ?? {};

        if (!repo || typeof repo !== "string" || !repo.includes("/")) {
          return res.status(400).json({ error: "repo must be in owner/repo format" });
        }

        // Rate-limit check
        const now = Date.now();
        const nextAllowed = importCooldowns.get(repo) ?? 0;
        if (now < nextAllowed) {
          const waitSec = Math.ceil((nextAllowed - now) / 1000);
          return res.status(429).json({
            error: `Rate limited. Try again in ${waitSec}s.`,
            retry_after: waitSec,
          });
        }
        importCooldowns.set(repo, now + IMPORT_COOLDOWN_MS);

        const [owner, repoName] = repo.split("/");
        const normalizedPath = (repoPath ?? "").replace(/^\/|\/$/g, "");
        const dirUrl = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/contents/${normalizedPath}?ref=${encodeURIComponent(ref)}`;

        // Fetch directory listing
        let entries;
        try {
          const dirRes = await safeFetch(dirUrl, { headers: githubHeaders(), allowedHosts: GITHUB_HOSTS, allowHttp: false });
          if (!dirRes.ok) {
            const body = await dirRes.text();
            return res.status(502).json({ error: `GitHub API error: ${dirRes.status}`, detail: body.slice(0, 200) });
          }
          entries = await dirRes.json();
        } catch (fetchErr) {
          return res.status(502).json({ error: `Failed to reach GitHub: ${fetchErr.message}` });
        }

        if (!Array.isArray(entries)) {
          return res.status(400).json({ error: "Path does not point to a directory or returned unexpected data" });
        }

        const jsonFiles = entries.filter((e) => e.type === "file" && e.name.endsWith(".json"));

        let imported = 0;
        let skipped = 0;
        const errors = [];

        for (const file of jsonFiles) {
          try {
            const rawRes = await safeFetch(file.download_url, { headers: githubHeaders(), allowedHosts: GITHUB_HOSTS, allowHttp: false });
            if (!rawRes.ok) {
              errors.push({ file: file.name, error: `HTTP ${rawRes.status}` });
              continue;
            }
            const entry = await rawRes.json();

            // Schema validation
            const validationError = validateAbiEntry(entry);
            if (validationError) {
              errors.push({ file: file.name, error: validationError });
              skipped++;
              continue;
            }

            // Idempotent upsert — only changed fields are updated (protocol_type auto-tagged)
            await db.upsertContractMeta({
              id: entry.contractId,
              name: entry.name,
              description: entry.description ?? null,
              functions: entry.functions ?? [],
              registered_by: `github:${repo}`,
              protocol_type: entry.protocol_type ?? undefined,
              version: entry.version ?? 1,
              abi_version: entry.abi_version ?? 0,
              min_ledger: entry.min_ledger ?? 0,
            });
            imported++;
          } catch (err) {
            errors.push({ file: file.name, error: err.message });
          }
        }

        // Release cooldown early if nothing was fetched (e.g., empty directory)
        if (jsonFiles.length === 0) {
          importCooldowns.delete(repo);
        }

        res.json({ imported, skipped, errors, total_files: jsonFiles.length });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });
  }

  // ── POST /api/admin/dlq/:id/retry ─────────────────────────────────────────
  // Triggers an immediate retry of the specified DLQ entry without waiting for
  // the scheduled retry window. Sets next_retry_at = NOW() so the next
  // processRetries() tick picks it up immediately.
  //
  // 400 — id is not a number
  // 404 — DLQ entry not found
  // 409 — DLQ entry is already resolved
  // 200 — { ok: true, id, next_retry_at }
  router.post("/dlq/:id/retry", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "id must be a number" });
    }
    try {
      const { rows } = await pool.query(`SELECT id, state FROM dead_letter_queue WHERE id = $1`, [id]);
      if (!rows.length) {
        return res.status(404).json({ error: `DLQ entry ${id} not found` });
      }
      if (rows[0].state === "resolved") {
        return res.status(409).json({ error: "DLQ entry is already resolved" });
      }
      // Also un-quarantines: a manual retry resets the attempt budget.
      const nextRetryAt = new Date().toISOString();
      await pool.query(
        `UPDATE dead_letter_queue SET state = 'queued', retry_count = 0, next_retry_at = $1, updated_at = NOW()
         WHERE id = $2`,
        [nextRetryAt, id],
      );
      return res.json({ ok: true, id, next_retry_at: nextRetryAt });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/admin/dlq (issue #851) ───────────────────────────────────────
  // Paginated DLQ listing, filterable by ?state= and ?error_class=.
  router.get("/dlq", async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 25));
    const state = req.query.state ? String(req.query.state) : undefined;
    if (state && !DLQ_STATES.includes(state)) {
      return res.status(400).json({ error: `state must be one of ${DLQ_STATES.join(", ")}` });
    }
    try {
      const errorClass = req.query.error_class ? String(req.query.error_class) : undefined;
      const { data, total } = await dlqGetItems({ page, limit, state, errorClass, resolved: false });
      return res.json({ data, total, page, limit });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/admin/dlq/:id/resolve (issue #851) ──────────────────────────
  router.post("/dlq/:id/resolve", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "id must be a number" });
    }
    try {
      const { rows } = await pool.query(`SELECT id FROM dead_letter_queue WHERE id = $1`, [id]);
      if (!rows.length) {
        return res.status(404).json({ error: `DLQ entry ${id} not found` });
      }
      await dlqResolve(id, req.body?.reason ? String(req.body.reason).slice(0, 500) : "manually resolved");
      return res.json({ ok: true, id });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/admin/dlq/replay?error_class= (issue #851) ──────────────────
  // Bulk re-queue of every open entry with the given error class. Chunked in
  // the DB; the background processor drains the queue at DLQ_BATCH_SIZE/tick.
  router.post("/dlq/replay", async (req, res) => {
    const errorClass = req.query.error_class ? String(req.query.error_class) : "";
    if (!errorClass) {
      return res.status(400).json({ error: "error_class is required" });
    }
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort(); // client went away → cancel remaining chunks
    });
    try {
      const requeued = await requeueByErrorClass(errorClass, { signal: controller.signal });
      return res.json({ ok: true, error_class: errorClass, requeued });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // Mount the router under /api/admin
  app.use("/api/admin", router);

  return router;
}
