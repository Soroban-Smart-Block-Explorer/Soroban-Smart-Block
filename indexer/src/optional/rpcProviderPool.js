/**
 * Issue #209 — Weighted RPC Provider Pool
 *
 * Manages 4+ Soroban RPC providers with health scoring based on:
 *   - uptime:     fraction of successful calls over a sliding window
 *   - avgLatency: rolling average response time (ms)
 *   - errorRate:  fraction of recent calls that errored
 *
 * A composite health score [0, 1] determines weighted-random provider selection;
 * degraded providers receive proportionally less traffic and are automatically
 * rotated out, then re-admitted after a successful recovery probe.
 */

import { SorobanRpc } from "@stellar/stellar-sdk";
import config from "./config.js";

const RPC_URLS = config.SOROBAN_RPC_URLS.length > 0 
  ? config.SOROBAN_RPC_URLS 
  : [config.SOROBAN_RPC_URL];

const WINDOW_SIZE = config.RPC_HEALTH_WINDOW;
const CALL_TIMEOUT_MS = config.RPC_CALL_TIMEOUT_MS;
const RECOVERY_INTERVAL_MS = config.RPC_RECOVERY_INTERVAL_MS;

export class RpcProvider {
  constructor(url) {
    this.url = url;
    this.server = new SorobanRpc.Server(url, { allowHttp: true });
    this._outcomes = [];
    this._latencies = [];
    this.healthy = true;
    this.latestLedger = 0;
  }

  /** Record the outcome of a single RPC call. */
  recordOutcome(success, latencyMs) {
    this._outcomes.push(success);
    this._latencies.push(latencyMs);
    if (this._outcomes.length > WINDOW_SIZE) this._outcomes.shift();
    if (this._latencies.length > WINDOW_SIZE) this._latencies.shift();
  }

  /** Uptime fraction [0, 1] over the sliding window. */
  get uptime() {
    if (!this._outcomes.length) return 1;
    return this._outcomes.filter(Boolean).length / this._outcomes.length;
  }

  /** Average response latency in ms. */
  get avgLatency() {
    if (!this._latencies.length) return 0;
    return this._latencies.reduce((a, b) => a + b, 0) / this._latencies.length;
  }

  /** Error rate fraction [0, 1] over the sliding window. */
  get errorRate() {
    return 1 - this.uptime;
  }

  /**
   * Composite health score [0, 1].
   * Weights: uptime 50% · inverse-latency 30% · inverse-error-rate 20%.
   */
  get healthScore() {
    const uptimeScore = this.uptime;
    const latencyScore = Math.max(0, 1 - this.avgLatency / CALL_TIMEOUT_MS);
    const errorScore = 1 - this.errorRate;
    return uptimeScore * 0.5 + latencyScore * 0.3 + errorScore * 0.2;
  }

  toJSON() {
    return {
      url: this.url,
      healthy: this.healthy,
      latestLedger: this.latestLedger,
      uptime: this.uptime,
      avgLatency: Math.round(this.avgLatency),
      errorRate: this.errorRate,
      healthScore: Number(this.healthScore.toFixed(4)),
    };
  }
}

const _providers = RPC_URLS.map((url) => new RpcProvider(url));

/**
 * Weighted-random provider selection.
 * Providers with higher health scores are chosen more often.
 *
 * @returns {RpcProvider}
 */
function selectProvider() {
  const candidates = _providers.filter((p) => p.healthy);
  if (!candidates.length) return _providers[0];

  const totalScore = candidates.reduce((s, p) => s + Math.max(0.01, p.healthScore), 0);
  let roll = Math.random() * totalScore;

  for (const p of candidates) {
    roll -= Math.max(0.01, p.healthScore);
    if (roll <= 0) return p;
  }
  return candidates[candidates.length - 1];
}

async function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`RPC timeout after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Call a method on the best available RPC provider.
 * Automatically fails over to healthy alternatives on error.
 *
 * @param {string} method  e.g. "getEvents", "getLatestLedger"
 * @param  {...any} args
 */
export async function call(method, ...args) {
  const tried = new Set();

  while (tried.size < _providers.length) {
    // Weighted selection: try to pick an untried provider
    let target = null;
    const candidate = selectProvider();
    if (!tried.has(candidate.url)) {
      target = candidate;
    } else {
      target = _providers.find((p) => !tried.has(p.url)) ?? null;
    }
    if (!target) break;

    tried.add(target.url);
    const start = Date.now();
    try {
      const result = await withTimeout(target.server[method](...args), CALL_TIMEOUT_MS);
      const latency = Date.now() - start;
      target.recordOutcome(true, latency);
      const ledger = result?.latestLedger ?? result?.sequence;
      if (ledger) target.latestLedger = ledger;
      if (!target.healthy) {
        target.healthy = true;
        console.log(`[rpcPool] provider ${target.url} recovered`);
      }
      return result;
    } catch (err) {
      const latency = Date.now() - start;
      target.recordOutcome(false, latency);
      if (target.errorRate >= 0.5) {
        target.healthy = false;
        console.warn(`[rpcPool] provider ${target.url} marked unhealthy (error_rate=${target.errorRate.toFixed(2)})`);
      }
      console.warn(`[rpcPool] provider ${target.url} failed (${err.message}), trying next`);
    }
  }

  throw new Error("[rpcPool] all RPC providers failed");
}

/** Return health status for all configured providers. */
export function getProviderStatus() {
  return _providers.map((p) => p.toJSON());
}

/** Proxy that delegates any method call through the weighted pool. */
export const rpcPool = new Proxy(
  {},
  {
    get(_target, method) {
      return (...args) => call(method, ...args);
    },
  },
);

// Periodic recovery probe for unhealthy providers.
// Unreffed so this background timer does not prevent the process from exiting.
setInterval(async () => {
  for (const provider of _providers) {
    if (!provider.healthy) {
      const start = Date.now();
      try {
        const res = await withTimeout(provider.server.getLatestLedger(), CALL_TIMEOUT_MS);
        provider.latestLedger = res.sequence;
        provider.recordOutcome(true, Date.now() - start);
        provider.healthy = true;
        console.log(`[rpcPool] provider ${provider.url} recovered`);
      } catch {
        provider.recordOutcome(false, Date.now() - start);
      }
    }
  }
}, RECOVERY_INTERVAL_MS).unref();
