/**
 * Uptime history recorder (issue #758).
 *
 * Samples the existing /health check on a schedule and persists it, so the
 * public status page can render rolling uptime percentages (e.g. 30 days)
 * instead of only the current instant.
 */
import cron from "node-cron";
import { pool } from "./db.js";
import { getHealthStatus } from "./health.js";

export async function recordUptimeCheck() {
  const health = await getHealthStatus();
  const { database, cache, indexer } = health.dependencies;
  await pool.query(
    `INSERT INTO uptime_checks (status, db_healthy, cache_healthy, indexer_healthy, ledger_lag_seconds)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      health.status,
      database.status === "healthy",
      cache.status === "healthy" || cache.status === "disabled",
      indexer.status === "healthy",
      indexer.lagSeconds ?? null,
    ],
  );
}

/** Starts the periodic uptime sampler (every 5 minutes). */
export function startUptimeRecorder() {
  recordUptimeCheck().catch((err) => console.warn("[uptime] initial check failed:", err.message));
  return cron.schedule("*/5 * * * *", () => {
    recordUptimeCheck().catch((err) => console.warn("[uptime] check failed:", err.message));
  });
}

/** Per-day uptime percentage over the trailing `days` window, oldest first. */
export async function getUptimeHistory(days = 30) {
  const { rows } = await pool.query(
    `SELECT
       date_trunc('day', checked_at) AS day,
       COUNT(*) FILTER (WHERE status = 'healthy') AS healthy_count,
       COUNT(*) AS total_count
     FROM uptime_checks
     WHERE checked_at > now() - ($1 || ' days')::interval
     GROUP BY 1
     ORDER BY 1`,
    [days],
  );
  return rows.map((r) => ({
    date: r.day.toISOString().slice(0, 10),
    uptime_pct: r.total_count > 0 ? Math.round((r.healthy_count / r.total_count) * 10000) / 100 : null,
  }));
}
