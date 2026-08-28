/**
 * Multi-Node RPC Validation Client
 *
 * Maintains a pool of Soroban RPC nodes. Queries are sent to the primary node;
 * if it fails or falls behind consensus, the client switches to the next healthy
 * node within 1 second.
 *
 * Usage:
 *   import { multiNodeRpc } from './rpcMultiNode.js';
 *   const res = await multiNodeRpc.getEvents(req);
 */

import { rpc as SorobanRpc } from "@stellar/stellar-sdk";
import config from "./config.js";

const RPC_URLS = config.SOROBAN_RPC_URLS.length > 0 
  ? config.SOROBAN_RPC_URLS 
  : [config.SOROBAN_RPC_URL];

// How many ledgers behind consensus before we consider a node lagging
const LAG_THRESHOLD = config.RPC_LAG_THRESHOLD;
// Timeout (ms) for a single RPC call before we try the next node
const CALL_TIMEOUT_MS = config.RPC_CALL_TIMEOUT_MS;
// Sliding-window sample cap for per-node health stats (getProviderStats)
const HEALTH_WINDOW = config.RPC_HEALTH_WINDOW;

const nodes = RPC_URLS.map((url) => ({
  url,
  server: new SorobanRpc.Server(url, { allowHttp: true }),
  healthy: true,
  latestLedger: 0,
  // Sliding-window call outcomes/latencies backing getProviderStats() below.
  _outcomes: [],
  _latencies: [],
}));

/** Record the outcome of a single call for uptime/latency/error-rate stats. */
function recordOutcome(node, success, latencyMs) {
  node._outcomes.push(success);
  if (node._outcomes.length > HEALTH_WINDOW) node._outcomes.shift();
  node._latencies.push(latencyMs);
  if (node._latencies.length > HEALTH_WINDOW) node._latencies.shift();
}

let primaryIndex = 0;

function nextHealthy(startIndex) {
  for (let i = 1; i <= nodes.length; i++) {
    const idx = (startIndex + i) % nodes.length;
    if (nodes[idx].healthy) return idx;
  }
  // All nodes unhealthy — reset and try primary anyway
  nodes.forEach((n) => {
    n.healthy = true;
  });
  return 0;
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

async function callWithFailover(method, ...args) {
  let idx = primaryIndex;

  for (let attempt = 0; attempt < nodes.length; attempt++) {
    const node = nodes[idx];
    const start = Date.now();
    try {
      const result = await withTimeout(node.server[method](...args), CALL_TIMEOUT_MS);
      recordOutcome(node, true, Date.now() - start);

      // Update latest ledger knowledge for lag detection
      const ledger = result?.latestLedger ?? result?.sequence;
      if (ledger) node.latestLedger = ledger;

      // Check if this node is lagging behind the best known ledger
      const bestLedger = Math.max(...nodes.map((n) => n.latestLedger));
      if (bestLedger - node.latestLedger > LAG_THRESHOLD) {
        console.warn(`[rpc-multi] node ${node.url} is ${bestLedger - node.latestLedger} ledgers behind, switching`);
        node.healthy = false;
        primaryIndex = nextHealthy(idx);
        idx = primaryIndex;
        continue;
      }

      // Promote to primary if we had to fail over
      if (idx !== primaryIndex) {
        console.log(`[rpc-multi] promoting ${node.url} to primary`);
        primaryIndex = idx;
      }

      return result;
    } catch (err) {
      recordOutcome(node, false, Date.now() - start);
      console.warn(`[rpc-multi] node ${node.url} failed (${err.message}), trying next`);
      node.healthy = false;
      idx = nextHealthy(idx);
    }
  }

  throw new Error("[rpc-multi] all RPC nodes failed");
}

// Periodically re-check unhealthy nodes so they can recover. Only started by
// the indexer daemon (src/index.js) — importing this module for its exports
// (e.g. in tests) must not have the side effect of scheduling network calls.
// unref() defensively, so even a direct call from a test can't keep the
// process alive on its own.
export function startNodeRecoveryPoll() {
  const interval = setInterval(async () => {
    for (const node of nodes) {
      if (!node.healthy) {
        const start = Date.now();
        try {
          const res = await withTimeout(node.server.getLatestLedger(), CALL_TIMEOUT_MS);
          recordOutcome(node, true, Date.now() - start);
          node.latestLedger = res.sequence;
          node.healthy = true;
          console.log(`[rpc-multi] node ${node.url} recovered`);
        } catch {
          recordOutcome(node, false, Date.now() - start);
          // still down
        }
      }
    }
  }, config.RPC_RECOVERY_INTERVAL_MS);
  interval.unref();
}

export const multiNodeRpc = new Proxy(
  {},
  {
    get(_, method) {
      return (...args) => callWithFailover(method, ...args);
    },
  },
);

export function getRpcNodeStatus() {
  return nodes.map(({ url, healthy, latestLedger }) => ({
    url,
    healthy,
    latestLedger,
  }));
}

/**
 * Health/performance snapshot for every configured RPC provider, for
 * GET /api/rpc/health. Sourced from the same sliding-window call outcomes
 * that drive failover, so it reflects real traffic rather than a separate
 * synthetic probe.
 *
 * healthScore [0, 100] weights: uptime 50% · inverse-latency 30% ·
 * inverse-error-rate 20% (uptime and error-rate are complementary here, but
 * kept as separate terms so the weighting stays legible).
 */
export function getProviderStats() {
  return nodes.map((node) => {
    const total = node._outcomes.length;
    const successCount = node._outcomes.filter(Boolean).length;
    const uptime = total ? Number(((successCount / total) * 100).toFixed(2)) : 100;
    const errorRate = total ? Number((((total - successCount) / total) * 100).toFixed(2)) : 0;
    const avgLatency = node._latencies.length
      ? Math.round(node._latencies.reduce((a, b) => a + b, 0) / node._latencies.length)
      : null;

    const latencyScore = avgLatency == null ? 1 : Math.max(0, 1 - avgLatency / CALL_TIMEOUT_MS);
    const healthScore = Math.round((uptime / 100) * 50 + latencyScore * 30 + (1 - errorRate / 100) * 20);

    return {
      url: node.url,
      healthy: node.healthy,
      uptime,
      avgLatency,
      errorRate,
      latestLedger: node.latestLedger,
      healthScore,
    };
  });
}
