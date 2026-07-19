import "dotenv/config";
import { rpc as SorobanRpc } from "@stellar/stellar-sdk";
import config from "./config.js";
import { startApi } from "./api.js";
import { db, pool } from "./db.js";
import { decode } from "./decoder.js";
import { startAbiSync } from "./githubAbiSync.js";
import { withRetry } from "./rpcRetry.js";
import { isHighBloatRisk } from "./bloatDetector.js";
import { detectUpgrade } from "./upgradeDetector.js";
import { classifyStorageWrites } from "./storageTierClassifier.js";
import { startBurnDetector } from "./burnDetector.js";
import { multiNodeRpc } from "./rpcMultiNode.js";
import { startMetricsCollector } from "./rpcMetrics.js";
import { startPruner } from "./pruner.js";
import { extractStateDiffs } from "./stateDiffIndexer.js";
import { parseFeeBump } from "./feeBumpParser.js";
import { detectEvictions } from "./archivalEvictionDetector.js";
import { parseAndDescribeRestore } from "./restoreFootprintParser.js";
import { publish, publishTransactionStatus } from "./wsEvents.js";
import { extractBuildMetadata } from "./wasmBuildMetadata.js";
import { scanFootprintContention } from "./footprintContentionScanner.js";
import { handleVaultEvent, refreshAllVaults } from "./vaultIndexer.js";
import { processCircuitBreakerEvent } from "./circuitBreakerIndexer.js";
import { startGasGuzzlersWorker } from "./gasGuzzlers.js";
import { recordLedgerHash } from "./reorgWorker.js";
import { warmCache } from "./cacheWarming.js";
import { cacheInvalidate } from "./cacheLayer.js";
import { eventsIngested, decodeLatency, rpcErrors, updateDbPoolMetrics } from "./metrics.js";
import { startUsageFlushCron, startRetentionCleanupCron } from "./usage/usageTracker.js";
import { startAuditPartitionCron } from "./audit/auditLogger.js";
import { updateIndexerStatus, updateWorkerStatus } from "./health.js";
import { logger } from "./logger.js";
import * as alertManager from "./alertManager.js";
import { initDeadLetterQueue, processRetries as dlqProcessRetries, enqueue as dlqEnqueue } from "./deadLetterQueue.js";
import { recordLedger as gapRecordLedger, analyze as gapAnalyze } from "./predictiveGapDetector.js";

const RPC_URL = config.SOROBAN_RPC_URL;
const START_LEDGER = config.START_LEDGER;
const POLL_MS = config.POLL_MS;
// Max events per RPC page — Soroban caps at 200
const PAGE_LIMIT = 200;
const MAX_GAP_RETRIES = 3;

const rpc = new SorobanRpc.Server(RPC_URL, { allowHttp: true });

// ── gap remediation queue ────────────────────────────────────────
// In-memory priority queue of gaps to re-index, ordered by from_ledger.
// Each entry: { from, to, retries, logId }.
let _gapQueue = [];

// ── persisted ledger cursor ────────────────────────────────────────
// The cursor is stored in the DB so the daemon resumes correctly after restart.
let _cursor = 0;

/**
 * For each unique tx_hash in the event batch, fetch the transaction and check
 * whether any operation is an UploadContractWasm.  When found, extract build
 * metadata from the raw WASM bytes and persist it.
 *
 * @param {string[]} txHashes  Deduplicated list of tx hashes from this page
 * @param {number}   ledger    Current ledger number
 */
async function indexWasmUploads(txHashes, ledger) {
  for (const txHash of txHashes) {
    try {
      const tx = await withRetry(() => rpc.getTransaction(txHash));
      if (!tx?.envelopeXdr) continue;

      const { xdr } = await import("@stellar/stellar-sdk");
      // SDK v12 returns envelopeXdr as a parsed xdr.TransactionEnvelope; older
      // paths may hand us a base64 string — support both.
      const envelope =
        typeof tx.envelopeXdr === "string"
          ? xdr.TransactionEnvelope.fromXDR(tx.envelopeXdr, "base64")
          : tx.envelopeXdr;
      // Select the correct union arm — calling the wrong accessor throws "Bad union switch"
      const envType = envelope.switch().name;
      const innerTx =
        envType === "envelopeTypeTxFeeBump"
          ? envelope.feeBump().tx().innerTx().v1().tx()
          : envType === "envelopeTypeTxV0"
            ? envelope.v0().tx()
            : envelope.v1().tx();
      const ops = innerTx.operations() ?? [];

      for (const op of ops) {
        const body = op.body();
        if (body.switch().name !== "invokeHostFunction") continue;
        const hf = body.invokeHostFunctionOp().hostFunction();
        if (hf.switch().name !== "hostFunctionTypeUploadContractWasm") continue;

        const wasmBytes = hf.wasm();
        const meta = extractBuildMetadata(wasmBytes);
        await db.upsertWasmBuildMetadata({ ...meta, ledger, tx_hash: txHash });
        console.log(
          `[${ledger}] WASM upload indexed: ${meta.wasm_hash.slice(0, 16)}… compiler=${meta.compiler ?? "unknown"}`,
        );
      }
    } catch (err) {
      // Non-fatal: log and continue
      console.error(`[wasmUpload] tx ${txHash}: ${err.message}`);
    }
  }
}

/**
 * Fetch and process ALL events for a given startLedger, handling pagination
 * boundaries when a ledger contains more than PAGE_LIMIT events
 *
 * Returns the latestLedger reported by the RPC node.
 */
async function indexLedger(ledger) {
  let pageCursor = undefined; // RPC pagination cursor (opaque string)
  let latestLedger = ledger;

  do {
    const req = {
      startLedger: pageCursor ? undefined : ledger, // only on first page
      filters: [{ type: "contract" }],
      limit: PAGE_LIMIT,
      ...(pageCursor ? { cursor: pageCursor } : {}),
    };

    const res = await withRetry(() => rpc.getEvents(req));
    latestLedger = res.latestLedger ?? latestLedger;

    // Flag footprint contention across transactions in this page's events
    scanFootprintContention(res.events);

    // Build a per-page txHash → feeBump cache to avoid redundant
    // getTransaction calls when multiple events share the same transaction.
    const feeBumpCache = new Map();
    const restoreCache = new Map(); // txHash → archival_info
    const uniqueTxHashes = [...new Set(res.events.map((e) => e.txHash).filter(Boolean))];
    await Promise.all(
      uniqueTxHashes.map(async (txHash) => {
        try {
          const txResult = await withRetry(() => rpc.getTransaction(txHash));
          if (txResult?.envelopeXdr) {
            feeBumpCache.set(txHash, parseFeeBump(txResult.envelopeXdr));
            // parse RestoreFootprintOp if present
            const restore = parseAndDescribeRestore(txResult.envelopeXdr, txResult.resultMetaXdr ?? null);
            if (restore.isRestoreOp) restoreCache.set(txHash, restore);
          }

          // Publish a transaction status event for clients
          try {
            const status = txResult?.status === "SUCCESS" ? "success" : txResult?.status === "FAILED" ? "failed" : "pending";
            const { extractFailureReason } = await import("./diagnosticParser.js");
            const payload = {
              tx_hash: txHash,
              status,
              ledger: txResult?.ledger ?? null,
              error: extractFailureReason(txResult),
            };
            publishTransactionStatus(payload);
          } catch (err) {
            /* non-fatal */
          }
        } catch {
          /* non-critical — skip fee-bump/restore for this tx */
        }
      }),
    );

    for (const ev of res.events) {
      const decodeStart = Date.now();
      const decoded = await decode(ev);
      decodeLatency.observe(Date.now() - decodeStart);
      eventsIngested.inc({ function: decoded.function });
      decoded.is_high_bloat_risk = isHighBloatRisk(ev, ev.contractId);
      decoded.footprint_contention = ev.footprint_contention ?? false;

      const upgrade = detectUpgrade(ev);
      if (upgrade) {
        console.log(`[${ev.ledger}] CONTRACT UPGRADE ${ev.contractId}: ${upgrade.oldHash} → ${upgrade.newHash}`);
        decoded.upgrade = upgrade;
      }

      decoded.storage_tiers = classifyStorageWrites(ev);
      decoded.fee_bump = feeBumpCache.get(ev.txHash) ?? null;
      // attach restoration info when this tx is a RestoreFootprintOp
      decoded.archival_info = restoreCache.get(ev.txHash) ?? null;
      await db.upsertEventValidated(decoded);

      // persist per-key state diffs for the timeline
      const diffs = extractStateDiffs(ev, decoded);
      if (diffs.length) await db.insertStateDiffs(diffs).catch(() => {});

      // detect evicted ledger keys (TTL → 0) in this transaction
      const evictions = detectEvictions(ev, ev.ledger, ev.txHash);
      if (evictions.length) {
        await db
          .insertArchivalEvictions(evictions)
          .catch((err) => console.error("[archivalEviction] insert failed:", err.message));
        console.log(`[${ev.ledger}] EVICTED ${evictions.length} key(s) in tx ${ev.txHash}`);
      }

      publish(decoded); // push to WS clients
      handleVaultEvent(decoded); // vault ratio update (async, non-blocking)

      // process circuit breaker events
      const meta = await db.getContractMeta(ev.contractId).catch(() => null);
      if (meta) {
        processCircuitBreakerEvent(decoded, meta).catch((err) =>
          console.error("[circuitBreakerIndexer] Error:", err.message),
        );
      }

      console.log(`[${ev.ledger}] ${decoded.function}: ${decoded.description}`);
    }

    // Scan transactions for UploadContractWasm operations (non-blocking)
    indexWasmUploads(uniqueTxHashes, ledger).catch((err) => console.error("[wasmUpload] batch error:", err.message));

    // record the latest ledger hash for re-org detection
    if (res.latestLedger && res.latestLedgerHash) {
      await recordLedgerHash(res.latestLedger, res.latestLedgerHash).catch(() => {});
    }

    // If the RPC returned a full page there may be more events; follow the cursor.
    pageCursor = res.events.length === PAGE_LIMIT ? res.cursor : undefined;
  } while (pageCursor);

  // Invalidate events list cache after each ledger so stale pages are evicted.
  if (latestLedger > ledger) {
    cacheInvalidate("events:list:*").catch(() => {});
  }

  return latestLedger;
}

let shutdown = false;

async function run() {
  await db.init();
  await initDeadLetterQueue();
  const server = startApi();
  // Poll DB pool stats every 15 s for Prometheus gauges
  setInterval(() => updateDbPoolMetrics(pool), 15_000);
  warmCache().catch((e) => logger.warn({ err: e.message }, "cache warm failed"));
  startAbiSync();
  startBurnDetector();
  startMetricsCollector(); // RPC latency probes
  startPruner(); // daily temporary-storage cleanup
  startGasGuzzlersWorker(); // daily gas consumption leaderboard

  // ── Auth & Rate Limiting cron jobs ─────────────────────────────────────────
  startUsageFlushCron();       // flush Redis usage counters → DB every minute
  startRetentionCleanupCron(); // nightly usage data retention cleanup
  startAuditPartitionCron();   // monthly audit log partition management

  // Bootstrap vault indexer: initial ratio snapshot for all registered vaults
  refreshAllVaults().catch(() => {});
  // Periodic ratio refresh + alert health checks every 60 s
  setInterval(() => {
    refreshAllVaults().catch(() => {});
    alertManager.checkIndexerDown().catch(() => {});
    alertManager.checkResourceConstraints().catch(() => {});
    dlqProcessRetries(async () => {}).catch(() => {}); // retry transient failures
  }, 60_000);

  // resume from the highest indexed ledger so no events are missed
  // after a restart. Fall back to START_LEDGER or (latest - 100) for first run.
  const dbMax = await db.getMaxLedger();
  _cursor =
    dbMax > 0 ? dbMax + 1 : START_LEDGER || (await withRetry(() => multiNodeRpc.getLatestLedger())).sequence - 100;

  logger.info({ ledger: _cursor }, "daemon starting");

  while (!shutdown) {
    try {
      // ── drain gap queue first ──────────────────────────────────────
      while (_gapQueue.length > 0 && !shutdown) {
        const gap = _gapQueue[0];
        console.log(`[gap] re-indexing ledgers ${gap.from} → ${gap.to} (attempt ${gap.retries + 1}/${MAX_GAP_RETRIES})`);
        let gapOk = true;
        for (let ledger = gap.from; ledger <= gap.to; ledger++) {
          if (shutdown) break;
          try {
            await indexLedger(ledger);
            gapRecordLedger(ledger);
          } catch (err) {
            logger.error({ err: err.message, ledger }, "gap re-index failed");
            gapOk = false;
            break;
          }
        }

        if (gapOk) {
          _gapQueue.shift();
          await db.closeGapLog(gap.logId).catch(() => {});
          logger.info({ from: gap.from, to: gap.to }, "gap closed");
        } else {
          gap.retries++;
          await db.incrementGapRetries(gap.logId).catch(() => {});
          if (gap.retries >= MAX_GAP_RETRIES) {
            _gapQueue.shift();
            await db.dlqGapLog(gap.logId).catch(() => {});
            await dlqEnqueue(
              { ledger: gap.from, _gapRange: `${gap.from}-${gap.to}` },
              new Error(`Gap ${gap.from}-${gap.to} failed after ${MAX_GAP_RETRIES} retries`),
            ).catch(() => {});
            logger.warn({ from: gap.from, to: gap.to }, "gap retries exhausted → DLQ");
          } else {
            // push to back for later retry
            _gapQueue.push(_gapQueue.shift());
          }
        }
      }

      // ── normal forward indexing ────────────────────────────────────
      console.log(`[daemon] polling from ledger ${_cursor}`);
      const latest = await indexLedger(_cursor);
      alertManager.recordPoll();
      gapRecordLedger(_cursor);

      // ── analyze gaps from recent ledgers ───────────────────────────
      try {
        const recentLedgers = await db.getRecentLedgers(100);
        const analysis = gapAnalyze(recentLedgers);

        for (const gap of analysis.gaps) {
          // fire alert
          alertManager.checkLedgerGap(gap.size, gap.from);

          // only enqueue if not already tracked in the gap queue or gap_log
          const alreadyQueued = _gapQueue.some((g) => g.from === gap.from && g.to === gap.to);
          if (!alreadyQueued) {
            const logId = await db.insertGapLog(gap.from, gap.to, gap.size).catch(() => null);
            _gapQueue.push({ from: gap.from, to: gap.to, retries: 0, logId });
            _gapQueue.sort((a, b) => a.from - b.from);
            logger.warn({ from: gap.from, to: gap.to, size: gap.size }, "gap detected → queued for re-index");
          }
        }
      } catch (err) {
        logger.error({ err: err.message }, "gap analysis failed");
      }

      const lagSeconds = Math.floor((Date.now() - (_cursor * 5000)) / 1000); // approximate lag
      updateIndexerStatus(_cursor, lagSeconds);
      _cursor = latest + 1;
      await db.saveCursor(_cursor);
    } catch (err) {
      logger.error({ err: err.message, ledger: _cursor }, "indexer error");
      rpcErrors.inc({ type: err.code ?? "unknown" });
      await alertManager.checkRpcHealth(false);
    }
    if (!shutdown) await new Promise((r) => setTimeout(r, POLL_MS));
  }

  logger.info("daemon shutting down");
  server?.close();
  process.exit(0);
}

process.on("SIGTERM", () => {
  shutdown = true;
  logger.info("SIGTERM received");
});
process.on("SIGINT", () => {
  shutdown = true;
  logger.info("SIGINT received");
});

run();
