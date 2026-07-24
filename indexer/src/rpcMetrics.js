/**
 * RPC Node Performance Metrics
 *
 * Background service that periodically probes each configured RPC node,
 * records latency and error-rate samples, and exposes them via
 * GET /api/rpc-metrics for the frontend dashboard.
 */

import { rpc as SorobanRpc } from "@stellar/stellar-sdk";
import config from "./config.js";

const RPC_URLS = config.SOROBAN_RPC_URLS.length > 0 
  ? config.SOROBAN_RPC_URLS 
  : [config.SOROBAN_RPC_URL];

const PROBE_INTERVAL_MS = config.METRICS_PROBE_INTERVAL_MS;
// Keep last N samples per node
const MAX_SAMPLES = config.METRICS_MAX_SAMPLES;

/** @type {Map<string, { latencies: number[], errors: number, total: number, lastLedger: number }>} */
const store = new Map(RPC_URLS.map((url) => [url, { latencies: [], errors: 0, total: 0, lastLedger: 0 }]));

async function probe(url) {
  const server = new SorobanRpc.Server(url, { allowHttp: true });
  const entry = store.get(url);
  const t0 = Date.now();

  try {
    const res = await server.getLatestLedger();
    const latencyMs = Date.now() - t0;

    entry.latencies.push(latencyMs);
    if (entry.latencies.length > MAX_SAMPLES) entry.latencies.shift();
    entry.lastLedger = res.sequence;
    entry.total++;
  } catch {
    entry.errors++;
    entry.total++;
  }
}

function summarise(url) {
  const { latencies, errors, total, lastLedger } = store.get(url);
  const sorted = [...latencies].sort((a, b) => a - b);
  const avg = sorted.length ? Math.round(sorted.reduce((s, v) => s + v, 0) / sorted.length) : null;
  const p95 = sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : null;
  const errorRate = total ? Number(((errors / total) * 100).toFixed(2)) : 0;
  const uptime = total ? Number((((total - errors) / total) * 100).toFixed(2)) : 100;

  return {
    url,
    latencyAvgMs: avg,
    latencyP95Ms: p95,
    errorRate,
    uptime,
    lastLedger,
    sampleCount: latencies.length,
    history: latencies.slice(-60), // last 60 samples for sparkline
  };
}

export function startMetricsCollector() {
  // Immediate first probe
  RPC_URLS.forEach(probe);

  setInterval(() => RPC_URLS.forEach(probe), PROBE_INTERVAL_MS);
  console.log(`[rpc-metrics] probing ${RPC_URLS.length} node(s) every ${PROBE_INTERVAL_MS}ms`);
}

export function getMetrics() {
  return RPC_URLS.map(summarise);
}
