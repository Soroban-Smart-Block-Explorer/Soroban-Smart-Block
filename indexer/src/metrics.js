/**
 * Prometheus metrics for the Soroban Explorer indexer.
 * Exposes: event ingestion rate, decode latency, DB pool utilisation, RPC errors.
 */
import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from "prom-client";

export const registry = new Registry();

// Collect default Node.js metrics (event loop lag, GC, heap, etc.)
collectDefaultMetrics({ register: registry });

/** Total Soroban events ingested from RPC. */
export const eventsIngested = new Counter({
  name: "soroban_events_ingested_total",
  help: "Total number of Soroban contract events ingested",
  labelNames: ["function"],
  registers: [registry],
});

/** Histogram of decode() durations in milliseconds. */
export const decodeLatency = new Histogram({
  name: "soroban_decode_duration_ms",
  help: "Event decode latency in milliseconds",
  buckets: [1, 5, 10, 25, 50, 100, 250, 500],
  registers: [registry],
});

/** Number of RPC errors by error type. */
export const rpcErrors = new Counter({
  name: "soroban_rpc_errors_total",
  help: "Total RPC errors encountered by the indexer",
  labelNames: ["type"],
  registers: [registry],
});

/** Current DB pool size (total connections). */
export const dbPoolTotal = new Gauge({
  name: "soroban_db_pool_total",
  help: "Total connections in the PostgreSQL pool",
  registers: [registry],
});

/** Current DB pool idle connections. */
export const dbPoolIdle = new Gauge({
  name: "soroban_db_pool_idle",
  help: "Idle connections in the PostgreSQL pool",
  registers: [registry],
});

/** Current DB pool waiting clients. */
export const dbPoolWaiting = new Gauge({
  name: "soroban_db_pool_waiting",
  help: "Clients waiting for a DB connection",
  registers: [registry],
});

/** Decoder schema violations (validation failures before DB insert). */
export const decoderSchemaViolationsTotal = new Counter({
  name: "soroban_decoder_schema_violations_total",
  help: "Total decoder schema validation failures by field",
  labelNames: ["field"],
  registers: [registry],
});

/** Cache hits/misses by cache layer type (e.g. cache="wallet"). */
export const cacheHitTotal = new Counter({
  name: "cache_hit_total",
  help: "Total cache hits by cache type",
  labelNames: ["cache"],
  registers: [registry],
});

export const cacheMissTotal = new Counter({
  name: "cache_miss_total",
  help: "Total cache misses by cache type",
  labelNames: ["cache"],
  registers: [registry],
});

/**
 * Update DB pool gauges from a pg.Pool instance.
 * Call this periodically (e.g. every 15 s).
 * @param {import('pg').Pool} pool
 */
export function updateDbPoolMetrics(pool) {
  dbPoolTotal.set(pool.totalCount);
  dbPoolIdle.set(pool.idleCount);
  dbPoolWaiting.set(pool.waitingCount);
}
