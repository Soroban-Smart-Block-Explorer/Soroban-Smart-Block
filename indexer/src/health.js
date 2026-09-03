/**
 * Comprehensive Health Check Module
 *
 * Separates liveness from readiness and tracks individual dependency health:
 * - Database (PostgreSQL)
 * - Cache (Redis L2)
 * - Indexer (ledger sync status)
 * - Workers (background jobs)
 *
 * Liveness: Service is running and should not be restarted
 * Readiness: Service can handle traffic (dependencies healthy)
 */

import { db, pool } from "./db.js";
import { getActiveAlerts } from "./alertManager.js";

// ── Configurable thresholds ───────────────────────────────────────────────────
// INDEXER_LAG_THRESHOLD_SECONDS: Threshold above which indexer is marked unhealthy
// Default: 120 seconds (2 minutes). When sync lag exceeds this, indexer status
// becomes "unhealthy", which downgrades overall health and readiness status.
const INDEXER_LAG_THRESHOLD_SECONDS =
  Number.parseInt(process.env.INDEXER_LAG_THRESHOLD_SECONDS ?? "120", 10) || 120;

// ── Health check state ────────────────────────────────────────────────────────
let _indexerStatus = { healthy: true, lastLedger: 0, lastSync: Date.now(), lagSeconds: 0, ledgerLag: 0 };
let _workerStatus = { healthy: true, errors: 0, lastRun: Date.now() };
let _dlqDepth = 0;

// ── Indexer stats (for the frontend's home-page stats bar) ────────────────
// COUNT(*) over `events` and `dead_letter_queue` on every /api/health poll
// (every 10s per client, and there may be several clients) would add
// avoidable load, so these are memoized for a few seconds.
let _statsCache = null;
let _statsCacheAt = 0;
const STATS_CACHE_MS = 5000;

async function getIndexerStats() {
  const now = Date.now();
  if (_statsCache && now - _statsCacheAt < STATS_CACHE_MS) return _statsCache;

  const [totalRes, recentRes, dlqRes] = await Promise.all([
    db.query("SELECT COUNT(*)::INT AS total FROM events"),
    db.query("SELECT COUNT(*)::INT AS recent FROM events WHERE created_at > NOW() - INTERVAL '5 minutes'"),
    db.query("SELECT COUNT(*)::INT AS failed FROM dead_letter_queue WHERE resolved = FALSE"),
  ]);

  const totalEvents = totalRes.rows[0]?.total ?? 0;
  const recentEvents = recentRes.rows[0]?.recent ?? 0;
  const failedDecodes = dlqRes.rows[0]?.failed ?? 0;
  const decodeAttempts = totalEvents + failedDecodes;

  _statsCache = {
    total_events: totalEvents,
    events_per_minute: Math.round((recentEvents / 5) * 10) / 10,
    decode_success_rate: decodeAttempts > 0 ? Math.round((totalEvents / decodeAttempts) * 10000) / 100 : 100,
  };
  _statsCacheAt = now;
  return _statsCache;
}

// Global Redis client reference (set by cacheLayer or health check)
let _redisClient = null;

/**
 * Set the Redis client for health checks
 * Called from cacheLayer.js or similar module during initialization
 */
export function setRedisClient(client) {
  _redisClient = client;
}

/**
 * Update indexer health status (called from main daemon)
 */
export function updateIndexerStatus(ledger, lagSeconds, ledgerLag = 0) {
  _indexerStatus = {
    healthy: lagSeconds < INDEXER_LAG_THRESHOLD_SECONDS, // unhealthy if lag exceeds threshold
    lastLedger: ledger,
    lastSync: Date.now(),
    lagSeconds,
    ledgerLag,
  };
}

/**
 * Update worker health status (called from worker jobs)
 */
export function updateWorkerStatus(errorCount = 0) {
  _workerStatus = {
    healthy: errorCount < 10, // unhealthy if >10 errors
    errors: errorCount,
    lastRun: Date.now(),
  };
}

/**
 * Update the dead-letter-queue depth reported on GET /api/health.
 * Called every 60s from the indexer daemon's periodic health loop, alongside
 * the dlq_depth Prometheus gauge and alertManager.checkDlqSize().
 */
export function updateDlqDepth(depth) {
  _dlqDepth = depth;
}

/**
 * Report worker error (increment error counter)
 */
export function reportWorkerError() {
  _workerStatus.errors = (_workerStatus.errors || 0) + 1;
  _workerStatus.healthy = _workerStatus.errors < 10;
  _workerStatus.lastRun = Date.now();
}

/**
 * Check database health
 * Tests connection and response time
 */
async function checkDatabase() {
  const start = Date.now();
  try {
    await db.query("SELECT 1 AS health_check");
    const responseTime = Date.now() - start;

    // Get pool stats
    const totalCount = pool.totalCount || 0;
    const idleCount = pool.idleCount || 0;
    const waitingCount = pool.waitingCount || 0;
    
    return {
      status: "healthy",
      responseTime,
      connections: {
        total: totalCount,
        idle: idleCount,
        active: totalCount - idleCount,
        waiting: waitingCount,
      },
    };
  } catch (err) {
    return {
      status: "unhealthy",
      error: err.message,
      responseTime: Date.now() - start,
    };
  }
}

/**
 * Check Redis cache health
 * Tests connection and response time
 */
async function checkCache() {
  if (!_redisClient) {
    return { status: "disabled", message: "Redis not configured" };
  }

  const start = Date.now();
  try {
    // Check if client is connected
    if (!_redisClient.isOpen) {
      return {
        status: "unhealthy",
        error: "Redis client not connected",
        responseTime: Date.now() - start,
      };
    }

    // Ping Redis
    await _redisClient.ping();
    const responseTime = Date.now() - start;
    
    // Get info if available
    let info = {};
    try {
      const infoStr = await _redisClient.info("stats");
      const lines = infoStr.split("\r\n");
      for (const line of lines) {
        if (line.includes("total_connections_received")) {
          const [, value] = line.split(":");
          info.totalConnections = parseInt(value, 10);
        }
        if (line.includes("instantaneous_ops_per_sec")) {
          const [, value] = line.split(":");
          info.opsPerSec = parseInt(value, 10);
        }
      }
    } catch {
      // Info not critical
    }

    return {
      status: "healthy",
      responseTime,
      ...info,
    };
  } catch (err) {
    return {
      status: "unhealthy",
      error: err.message,
      responseTime: Date.now() - start,
    };
  }
}

/**
 * Check indexer health
 * Reports ledger sync status and lag
 */
function checkIndexer() {
  const timeSinceLastSync = Date.now() - _indexerStatus.lastSync;
  const stale = timeSinceLastSync > 30_000; // no sync in 30s = stale

  return {
    status: _indexerStatus.healthy && !stale ? "healthy" : "unhealthy",
    lastLedger: _indexerStatus.lastLedger,
    lagSeconds: _indexerStatus.lagSeconds,
    ledgerLag: _indexerStatus.ledgerLag,
    lastSyncAgo: Math.floor(timeSinceLastSync / 1000),
  };
}

/**
 * Check worker health
 * Reports background job status
 */
function checkWorkers() {
  const timeSinceLastRun = Date.now() - _workerStatus.lastRun;
  const stale = timeSinceLastRun > 300_000; // no run in 5 minutes = stale

  return {
    status: _workerStatus.healthy && !stale ? "healthy" : "degraded",
    errors: _workerStatus.errors,
    lastRunAgo: Math.floor(timeSinceLastRun / 1000),
  };
}

/**
 * Comprehensive health check
 * Returns detailed status for all dependencies
 */
export async function getHealthStatus() {
  const [database, cache, stats] = await Promise.all([
    checkDatabase(),
    checkCache(),
    getIndexerStats().catch(() => ({ total_events: null, events_per_minute: null, decode_success_rate: null })),
  ]);

  const indexer = checkIndexer();
  const workers = checkWorkers();
  const activeAlerts = getActiveAlerts();

  // Overall status: healthy if all critical dependencies are healthy
  // Cache is optional, workers are degradable
  const criticalHealthy = database.status === "healthy" && indexer.status === "healthy";
  const allHealthy = criticalHealthy &&
    (cache.status === "healthy" || cache.status === "disabled") &&
    workers.status === "healthy";

  return {
    status: allHealthy ? "healthy" : criticalHealthy ? "degraded" : "unhealthy",
    timestamp: new Date().toISOString(),
    dependencies: {
      database,
      cache,
      indexer,
      workers,
    },
    // Powers the frontend's compact home-page stats bar (polled every 10s).
    stats: {
      total_events: stats.total_events,
      events_per_minute: stats.events_per_minute,
      indexer_lag_ledgers: indexer.ledgerLag,
      decode_success_rate: stats.decode_success_rate,
    },
    alerts: {
      active_count: activeAlerts.length,
      conditions: activeAlerts.map(({ condition }) => condition),
    },
    dlq: {
      depth: _dlqDepth,
    },
  };
}

/**
 * Liveness check
 * Returns 200 if service is running (should not be restarted)
 */
export function getLivenessStatus() {
  return {
    status: "alive",
    timestamp: new Date().toISOString(),
  };
}

/**
 * Readiness check
 * Returns 200 if service can handle traffic (dependencies healthy)
 */
export async function getReadinessStatus() {
  const health = await getHealthStatus();
  
  // Ready if status is healthy or degraded (not unhealthy)
  const ready = health.status !== "unhealthy";
  
  return {
    status: ready ? "ready" : "not_ready",
    timestamp: new Date().toISOString(),
    reason: ready ? null : "Critical dependencies unhealthy",
    dependencies: health.dependencies,
  };
}
