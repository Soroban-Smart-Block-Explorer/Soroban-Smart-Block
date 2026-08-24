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

const nodes = RPC_URLS.map((url) => ({
  url,
  server: new SorobanRpc.Server(url, { allowHttp: true }),
  healthy: true,
  latestLedger: 0,
}));

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
    try {
      const result = await withTimeout(node.server[method](...args), CALL_TIMEOUT_MS);

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
export function startNodeRecoveryPoll() {
  setInterval(async () => {
    for (const node of nodes) {
      if (!node.healthy) {
        try {
          const res = await withTimeout(node.server.getLatestLedger(), CALL_TIMEOUT_MS);
          node.latestLedger = res.sequence;
          node.healthy = true;
          console.log(`[rpc-multi] node ${node.url} recovered`);
        } catch {
          // still down
        }
      }
    }
  }, config.RPC_RECOVERY_INTERVAL_MS);
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
