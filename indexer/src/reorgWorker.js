import { logger } from "./logger.js";
/**
 * Ledger Re-org Detection & Rollback Worker 
 *
 * Maintains a rolling window of indexed ledger hashes and compares them
 * against the network's consensus state.  When a mismatch is detected the
 * orphaned rows are purged and the cursor is rewound to the fork height so
 * the main indexer loop can re-index from there.
 */

import { db } from "./db.js";
import * as alertManager from "./alertManager.js";
import config from "./config.js";

// ── DB helpers ────────────────────────────────────────────────────────────────

/** Persist the hash we observed for a ledger when we first indexed it. */
export async function recordLedgerHash(ledger, hash) {
  await db.recordLedgerHash(ledger, hash);
}

/** Return the last N ledger rows we have on record, newest first. */
async function getRecentLedgerHashes(limit = config.REORG_CHECK_INTERVAL + config.REORG_MAX_DEPTH) {
  return db.getRecentLedgerHashes(limit);
}

/** Delete orphaned rows and atomically persist the rewind cursor. */
export async function rollback(forkLedger) {
  await db.rollbackFromLedger(forkLedger);
  logger.warn(`[reorg] Rolled back ledger ${forkLedger}+`);
}

// ── Core check ────────────────────────────────────────────────────────────────

/**
 * Compare our stored hashes against the network.
 *
 * Supports two call patterns:
 * 1. Legacy RPC-backed scan: checkForReorg(rpc, dependencies)
 * 2. Immediate fast-path: checkForReorg(latestLedger, latestLedgerHash)
 *
 * A detected mismatch is rolled back atomically before the fork height is
 * returned to the caller for its in-memory cursor rewind. Alert delivery is
 * best-effort and cannot block that recovery path.
 *
 * @param {import("@stellar/stellar-sdk").SorobanRpc.Server | number} rpcOrLatestLedger
 * @param {{
 *   getStoredHashes?: (limit: number) => Promise<Array<{ledger: number|string, hash: string}>>,
 *   rollbackFork?: (ledger: number) => Promise<void>,
 *   alertReorg?: (ledger: number) => Promise<void>,
 *   checkInterval?: number,
 *   maxDepth?: number,
 *   latestLedger?: number,
 *   latestLedgerHash?: string
 * } | string} dependencies Optional test seams or the latest ledger hash.
 * @returns {Promise<number|null>} fork ledger height, or null if no reorg
 */
export async function checkForReorg(latestLedgerOrRpc, latestLedgerHashOrDependencies = {}) {
  const fastPath =
    typeof latestLedgerOrRpc === "number" &&
    typeof latestLedgerHashOrDependencies === "string";

  const getStoredHashes =
    fastPath || !latestLedgerHashOrDependencies
      ? getRecentLedgerHashes
      : latestLedgerHashOrDependencies.getStoredHashes ?? getRecentLedgerHashes;
  const rollbackFork =
    fastPath || !latestLedgerHashOrDependencies
      ? rollback
      : latestLedgerHashOrDependencies.rollbackFork ?? rollback;
  const alertReorg =
    fastPath || !latestLedgerHashOrDependencies
      ? alertManager.alertReorg
      : latestLedgerHashOrDependencies.alertReorg ?? alertManager.alertReorg;
  const checkInterval =
    fastPath || !latestLedgerHashOrDependencies
      ? config.REORG_CHECK_INTERVAL
      : latestLedgerHashOrDependencies.checkInterval ?? config.REORG_CHECK_INTERVAL;
  const maxDepth =
    fastPath || !latestLedgerHashOrDependencies
      ? config.REORG_MAX_DEPTH
      : latestLedgerHashOrDependencies.maxDepth ?? config.REORG_MAX_DEPTH;

  const lookback = checkInterval + maxDepth;
  const stored = await getStoredHashes(lookback);
  if (stored.length === 0) return null;

  if (fastPath) {
    const latestLedger = latestLedgerOrRpc;
    const latestLedgerHash = latestLedgerHashOrDependencies;
    const latestEntry = stored.find((row) => Number(row.ledger) === latestLedger);
    if (!latestEntry) return null;
    if (latestEntry.hash !== latestLedgerHash) {
      logger.warn(`[reorg] Mismatch at ledger ${latestLedger}: stored=${latestEntry.hash} network=${latestLedgerHash}`);
      await rollbackFork(latestLedger);
      try {
        await alertReorg(latestLedger);
      } catch (err) {
        logger.error(`[reorg] Alert failed at ledger ${latestLedger}: ${err.message}`);
      }
      return latestLedger;
    }
    return null;
  }

  const rpc = latestLedgerOrRpc;
  let earliestFork = null;
  for (const { ledger, hash } of stored) {
    const ledgerNumber = Number(ledger);
    let networkHash;
    try {
      const info = await rpc.getLedger(ledgerNumber).catch(() => null);
      networkHash = info?.hash ?? null;
    } catch {
      continue;
    }

    if (networkHash && networkHash !== hash) {
      logger.warn(`[reorg] Mismatch at ledger ${ledgerNumber}: stored=${hash} network=${networkHash}`);
      earliestFork = earliestFork === null ? ledgerNumber : Math.min(earliestFork, ledgerNumber);
    }
  }

  if (earliestFork === null) return null;

  await rollbackFork(earliestFork);
  try {
    await alertReorg(earliestFork);
  } catch (err) {
    logger.error(`[reorg] Alert failed at ledger ${earliestFork}: ${err.message}`);
  }
  return earliestFork;
}

// ── Worker entry-point ────────────────────────────────────────────────────────

/**
 * Start a periodic re-org check for embedded callers.
 * The main daemon intentionally calls checkForReorg() inline instead, keeping
 * cursor ownership single-flight with ledger indexing.
 *
 * @param {import("@stellar/stellar-sdk").SorobanRpc.Server} rpc
 * @param {{ getCursor: () => number, setCursor: (n: number) => void }} cursorRef
 *   Callbacks to read/write the main indexer's current ledger cursor so we
 *   can rewind it to the fork height after a rollback.
 * @param {number} intervalMs  How often to run the check (default 30 s).
 * @returns {() => void}  Stop function.
 */
export function startReorgWorker(rpc, cursorRef, intervalMs = 30_000) {
  let running = true;

  (async () => {
    logger.info("[reorg] Worker started");

    while (running) {
      await new Promise((r) => setTimeout(r, intervalMs));
      if (!running) break;

      try {
        const forkLedger = await checkForReorg(rpc);
        if (forkLedger !== null) {
          cursorRef.setCursor(forkLedger); // rewind main loop
          logger.info(`[reorg] Cursor rewound to ${forkLedger}`);
        }
      } catch (err) {
        logger.error("[reorg] Check failed:", err.message);
      }
    }
  })();

  return () => {
    running = false;
  };
}
