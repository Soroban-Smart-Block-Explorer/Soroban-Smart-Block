import "dotenv/config";
import { invalidateContract as invalidateContractSpec } from "./contractSpecCache.js";
import { initRuntimeConfig } from "./runtimeConfig.js";
import "./tracing.js";
import { pathToFileURL } from "node:url";
import { rpc as SorobanRpc } from "@stellar/stellar-sdk";
import { initSentry } from "./sentry.js";
import { startProfiling } from "./profiling.js";
import config from "./config.js";

initSentry();
startProfiling();
import { startApi } from "./api.js";
import {
  tryAcquireLock,
  isLeader,
  start as startLeaderElection,
  stop as stopLeaderElection,
} from "./optional/leaderElection.js";
import { db, pool } from "./db.js";
import { startLineageBatch } from "./lineage.js";
import { decode, getDecodeStats } from "./decoder.js";
import { startAbiSync } from "./githubAbiSync.js";
import { seedBuiltinAbis } from "./abiSeeder.js";
import { startContractVerifier, recordOnChainHash } from "./contractVerifier.js";
import { startQueryJobMaintenance } from "./jobs/queryJobs.js";
import { withRetry } from "./rpcRetry.js";
import { isHighBloatRisk } from "./bloatDetector.js";
import { detectUpgrade } from "./upgradeDetector.js";
import { classifyStorageWrites } from "./storageTierClassifier.js";
import { startBurnDetector } from "./burnDetector.js";
import { multiNodeRpc, startNodeRecoveryPoll } from "./rpcMultiNode.js";
import { startMetricsCollector } from "./rpcMetrics.js";
import { startPruner } from "./pruner.js";
import { extractStateDiffs } from "./stateDiffIndexer.js";
import { extractStateVersions } from "./stateHistoryIndexer.js";
import { observeProtocolVersion, protocolVersionFromLedger, isProtocolDegraded } from "./protocolReadiness.js";
import { parseFeeBump } from "./feeBumpParser.js";
import { extractTransactionRecord } from "./transactions.js";
import { detectEvictions } from "./archivalEvictionDetector.js";
import { parseAndDescribeRestore } from "./restoreFootprintParser.js";
import { publishTransactionStatus } from "./wsEvents.js";
import { enqueueOutbox, startOutboxRelay } from "./outboxRelay.js";
import { extractBuildMetadata } from "./wasmBuildMetadata.js";
import { scanFootprintContention } from "./footprintContentionScanner.js";
import { handleVaultEvent, refreshAllVaults } from "./vaultIndexer.js";
import { processCircuitBreakerEvent } from "./circuitBreakerIndexer.js";
import { startGasGuzzlersWorker } from "./gasGuzzlers.js";
import { checkForReorg, recordLedgerHash } from "./reorgWorker.js";
import { startReDecodeWorker } from "./reDecodeWorker.js";
import { warmCache } from "./cacheWarming.js";
import { cacheInvalidate } from "./cacheLayer.js";
import { enqueuePurge } from "./cdnPurge.js";
import {
  eventsIngested,
  decodeLatency,
  rpcErrors,
  updateDbPoolMetrics,
  dlqDepth,
  indexerLagLedgers,
} from "./metrics.js";
import { startUsageFlushCron, startRetentionCleanupCron } from "./usage/usageTracker.js";
import { startAuditPartitionCron, startAuditFlush } from "./audit/auditLogger.js";
import { startUptimeRecorder } from "./uptimeRecorder.js";
import { updateIndexerStatus, updateDlqDepth, setDraining } from "./health.js";
import { logger } from "./logger.js";
import * as alertManager from "./alertManager.js";
import {
  processRetries as dlqProcessRetries,
  enqueue as dlqEnqueue,
  getDlqDepth,
  refreshDlqHealth,
} from "./deadLetterQueue.js";
import { recordLedger as gapRecordLedger } from "./predictiveGapDetector.js";
import { retryWebhookDelivery } from "./webhookDelivery.js";
import { runIntegrityChecks } from "./routes/admin.js";
import { createIngestPipeline } from "./ingestPipeline.js";

const RPC_URL = config.SOROBAN_RPC_URL;
const START_LEDGER = config.START_LEDGER;
const POLL_MS = config.POLL_MS;
const REORG_CHECK_INTERVAL = config.REORG_CHECK_INTERVAL;
// Max events per RPC page — Soroban caps at 200
const PAGE_LIMIT = 200;
const MAX_GAP_RETRIES = 3;
const INGEST_CONCURRENCY = 4;
const INGEST_BATCH_SIZE = 64;
const INGEST_MAX_QUEUE = 2000;

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
        typeof tx.envelopeXdr === "string" ? xdr.TransactionEnvelope.fromXDR(tx.envelopeXdr, "base64") : tx.envelopeXdr;
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
        logger.info(
          `[${ledger}] WASM upload indexed: ${meta.wasm_hash.slice(0, 16)}… compiler=${meta.compiler ?? "unknown"}`,
        );
      }
    } catch (err) {
      // Non-fatal: log and continue
      logger.error(`[wasmUpload] tx ${txHash}: ${err.message}`);
    }
  }
}

/**
 * Load transaction-scoped enrichments shared by normal indexing and DLQ
 * retries. RPC, parsing, and transaction-status failures remain non-critical,
 * matching the original page-prefetch behavior.
 *
 * @param {string | null | undefined} txHash
 * @param {object} adapters optional adapters for deterministic callers/tests
 * @returns {Promise<{ feeBump: object | null, archivalInfo: object | null }>}
 */
export async function loadTransactionContext(
  txHash,
  {
    fetchTransaction = (hash) => withRetry(() => rpc.getTransaction(hash)),
    parseFeeBumpEnvelope = parseFeeBump,
    parseRestoreEnvelope = parseAndDescribeRestore,
    publishStatus = publishTransactionStatus,
    extractFailure = async (txResult) => {
      const { extractFailureReason } = await import("./diagnosticParser.js");
      return extractFailureReason(txResult);
    },
  } = {},
) {
  const context = { feeBump: null, archivalInfo: null, transaction: null };
  if (!txHash) return context;

  try {
    const txResult = await fetchTransaction(txHash);
    context.transaction = txResult;
    if (txResult?.envelopeXdr) {
      context.feeBump = parseFeeBumpEnvelope(txResult.envelopeXdr);
      const restore = parseRestoreEnvelope(txResult.envelopeXdr, txResult.resultMetaXdr ?? null);
      if (restore.isRestoreOp) context.archivalInfo = restore;
    }

    try {
      const status = txResult?.status === "SUCCESS" ? "success" : txResult?.status === "FAILED" ? "failed" : "pending";
      publishStatus({
        tx_hash: txHash,
        status,
        ledger: txResult?.ledger ?? null,
        error: await extractFailure(txResult),
      });
    } catch {
      /* non-fatal transaction-status enrichment */
    }
  } catch {
    /* non-critical transaction lookup/enrichment failure */
  }

  return context;
}

/**
 * Run one raw Soroban RPC event through the complete indexing pipeline.
 *
 * Transaction-level fee-bump and restore metadata is collected once per page
 * by indexLedger and supplied here. A one-argument DLQ call loads the same
 * transaction context before decoding and persisting the event.
 *
 * @param {object} rawSorobanEvent
 * @param {{ feeBump: object | null, archivalInfo: object | null }} context
 * @returns {Promise<object>} the decoded event that was persisted
 */
export async function processSingleEvent(rawSorobanEvent, context = undefined, lineageBatchId = null) {
  const { feeBump, archivalInfo } = context ?? (await loadTransactionContext(rawSorobanEvent.txHash));
  await observeProtocolVersion(protocolVersionFromLedger(rawSorobanEvent));
  const decodeStart = Date.now();
  let decoded;
  try {
    decoded = await decode(rawSorobanEvent);
  } catch (error) {
    if (!/unknown|arm|union|xdr/i.test(error.message)) throw error;
    decoded = { contract_id: rawSorobanEvent.contractId, ledger: Number(rawSorobanEvent.ledger), tx_hash: rawSorobanEvent.txHash ?? "unknown", function: "unknown", description: "Deferred: unsupported protocol XDR", raw_topics: rawSorobanEvent.topic ?? [], raw_data: typeof rawSorobanEvent.value === "string" ? rawSorobanEvent.value : JSON.stringify(rawSorobanEvent.value ?? null), protocol_degraded: true, raw_xdr: rawSorobanEvent.rawXdr ?? rawSorobanEvent.xdr ?? null };
  }
  const contractMeta = await db.getContractMeta(rawSorobanEvent.contractId).catch(() => null);
  decoded.abi_version = Number(contractMeta?.abi_version ?? 0);
  decoded.protocol_version = protocolVersionFromLedger(rawSorobanEvent);
  decoded.protocol_degraded = decoded.protocol_degraded || isProtocolDegraded();
  decodeLatency.observe(Date.now() - decodeStart);
  eventsIngested.inc({ function: decoded.function });
  decoded.is_high_bloat_risk = isHighBloatRisk(rawSorobanEvent, rawSorobanEvent.contractId);
  decoded.footprint_contention = rawSorobanEvent.footprint_contention ?? false;

  const upgrade = detectUpgrade(rawSorobanEvent);
  if (upgrade) {
    logger.info(
      `[${rawSorobanEvent.ledger}] CONTRACT UPGRADE ${rawSorobanEvent.contractId}: ${upgrade.oldHash} → ${upgrade.newHash}`,
    );
    decoded.upgrade = upgrade;
    invalidateContractSpec(rawSorobanEvent.contractId); // new WASM → new spec from this ledger on (#895)
    // Source-verification badge re-checks against the new code hash (#796).
    await recordOnChainHash(rawSorobanEvent.contractId, upgrade.newHash, rawSorobanEvent.ledger).catch(() => {});
    if (decoded.abi_version > 0) {
      await db.markNeedsRedecode(rawSorobanEvent.contractId, decoded.abi_version);
    }
  }

  decoded.storage_tiers = classifyStorageWrites(rawSorobanEvent);
  decoded.fee_bump = feeBump;
  decoded.archival_info = archivalInfo;
  if (context?.transaction && rawSorobanEvent.txHash) {
    const tx = context.transaction;
    db.upsertTransaction(await extractTransactionRecord({
      hash: rawSorobanEvent.txHash,
      ledger: tx.ledger ?? rawSorobanEvent.ledger,
      source: tx.sourceAccount ?? tx.source_account,
      status: tx.status,
      resultCode: tx.resultCode ?? tx.result_code,
      envelopeXdr: tx.envelopeXdr,
      resultMetaXdr: tx.resultMetaXdr,
      fee: tx.feeBreakdown ?? tx.fee,
      diagnostics: tx.resultMetaXdr,
    })).catch((err) => logger.warn({ err: err.message }, "transaction indexing failed"));
  }
  decoded.lineage_batch_id = lineageBatchId;
  await db.upsertEventValidated(decoded);
  // The event row is committed before it is exposed to consumers. The outbox
  // relay provides durable retries and stable event IDs for deduplication.
  const outboxClient = await pool.connect();
  try {
    await outboxClient.query("BEGIN");
    await enqueueOutbox(outboxClient, { topic: "event", payload: decoded }, { eventId: String(decoded.seq ?? `${decoded.contract_id}:${decoded.ledger}:${decoded.tx_hash}`) });
    await outboxClient.query("COMMIT");
  } catch (error) {
    await outboxClient.query("ROLLBACK").catch(() => {});
    logger.error({ err: error.message, ledger: decoded.ledger }, "outbox enqueue failed");
  } finally { outboxClient.release(); }
  // Bust wallet event caches (#534) — any new event may reference a wallet address.
  cacheInvalidate("wallet:events:*").catch(() => {});
  // WebSocket/webhook fan-out is performed by the post-commit relay.

  // Persist per-key state diffs for the timeline.
  const diffs = extractStateDiffs(rawSorobanEvent, decoded);
  if (diffs.length) await db.insertStateDiffs(diffs).catch(() => {});
  const stateVersions = extractStateVersions({ ...rawSorobanEvent, txMeta: rawSorobanEvent.txMeta });
  if (stateVersions.length) await db.upsertStateVersions(stateVersions).catch((err) => logger.error("[state-history] insert failed:", err.message));

  // Detect evicted ledger keys (TTL → 0) in this transaction.
  const evictions = detectEvictions(rawSorobanEvent, rawSorobanEvent.ledger, rawSorobanEvent.txHash);
  if (evictions.length) {
    await db
      .insertArchivalEvictions(evictions)
      .catch((err) => logger.error("[archivalEviction] insert failed:", err.message));
    logger.info(`[${rawSorobanEvent.ledger}] EVICTED ${evictions.length} key(s) in tx ${rawSorobanEvent.txHash}`);
  }

  handleVaultEvent(decoded); // vault ratio update (async, non-blocking)

  // Process circuit breaker events.
  if (contractMeta) {
    processCircuitBreakerEvent(decoded, contractMeta).catch((err) =>
      logger.error("[circuitBreakerIndexer] Error:", err.message),
    );
  }

  logger.info(`[${rawSorobanEvent.ledger}] ${decoded.function}: ${decoded.description}`);
  return decoded;
}

export async function processEventBatch(batch, contextByTx = new Map(), lineageBatchId = null) {
  if (!Array.isArray(batch) || batch.length === 0) return [];

  const resolved = await Promise.all(
    batch.map(async (rawSorobanEvent) => {
      const { feeBump, archivalInfo } = contextByTx.get(rawSorobanEvent.txHash) ??
        (await loadTransactionContext(rawSorobanEvent.txHash));
      const decodeStart = Date.now();
      const decoded = await decode(rawSorobanEvent);
      const contractMeta = await db.getContractMeta(rawSorobanEvent.contractId).catch(() => null);
      decoded.abi_version = Number(contractMeta?.abi_version ?? 0);
      decodeLatency.observe(Date.now() - decodeStart);
      eventsIngested.inc({ function: decoded.function });
      decoded.is_high_bloat_risk = isHighBloatRisk(rawSorobanEvent, rawSorobanEvent.contractId);
      decoded.footprint_contention = rawSorobanEvent.footprint_contention ?? false;

      const upgrade = detectUpgrade(rawSorobanEvent);
      if (upgrade) {
        decoded.upgrade = upgrade;
        await recordOnChainHash(rawSorobanEvent.contractId, upgrade.newHash, rawSorobanEvent.ledger).catch(() => {});
        if (decoded.abi_version > 0) {
          await db.markNeedsRedecode(rawSorobanEvent.contractId, decoded.abi_version).catch(() => {});
        }
      }

      decoded.storage_tiers = classifyStorageWrites(rawSorobanEvent);
      decoded.fee_bump = feeBump;
      decoded.archival_info = archivalInfo;
      decoded.lineage_batch_id = lineageBatchId;
      return { rawSorobanEvent, decoded, contractMeta };
    }),
  );

  await db.upsertEventsValidatedBatch(
    resolved.map(({ decoded }) => decoded),
    logger,
  );

  for (const { rawSorobanEvent, decoded, contractMeta } of resolved) {
    cacheInvalidate("wallet:events:*").catch(() => {});
    deliverWebhooksForEvent(decoded).catch((err) =>
      logger.error("[webhookDelivery] dispatch failed:", err.message),
    );

    const diffs = extractStateDiffs(rawSorobanEvent, decoded);
    if (diffs.length) await db.insertStateDiffs(diffs).catch(() => {});

    const evictions = detectEvictions(rawSorobanEvent, rawSorobanEvent.ledger, rawSorobanEvent.txHash);
    if (evictions.length) {
      await db
        .insertArchivalEvictions(evictions)
        .catch((err) => logger.error("[archivalEviction] insert failed:", err.message));
    }

    publish(decoded);
    handleVaultEvent(decoded);

    if (contractMeta) {
      processCircuitBreakerEvent(decoded, contractMeta).catch((err) =>
        logger.error("[circuitBreakerIndexer] Error:", err.message),
      );
    }

    logger.info(`[${rawSorobanEvent.ledger}] ${decoded.function}: ${decoded.description}`);
  }

  return resolved.map(({ decoded }) => decoded);
}

/**
 * dead_letter_queue.processRetries() calls a single handler for every due
 * entry regardless of what originally failed — dispatch webhook-delivery
 * retries (marked `kind: "webhook_delivery"` by webhookDelivery.js) to their
 * own handler, and fall back to the normal ledger-event retry path for
 * everything else.
 */
async function dlqRetryDispatch(rawEvent) {
  if (rawEvent?.kind === "webhook_delivery") {
    return retryWebhookDelivery(rawEvent);
  }
  return processSingleEvent(rawEvent);
}

/**
 * Fetch and process ALL events for a given startLedger, handling pagination
 * boundaries when a ledger contains more than PAGE_LIMIT events.
 *
 * Returns the latest ledger sequence plus the corresponding chain hash that
 * the RPC reported for that poll span.
 */
export async function indexLedger(
  ledger,
  { endLedger = null, pageDelayMs = 0, ignoreLeadership = false, suppressExternalEffects = false } = {},
) {
  const checkLeadership = () => {
    if (!ignoreLeadership) assertLeadership();
  };
  checkLeadership();
  let pageCursor = undefined; // RPC pagination cursor (opaque string)
  let latestLedger = ledger;
  let latestLedgerHash = null;
  let eventsProcessed = 0;

  do {
    checkLeadership();
    const req = {
      startLedger: pageCursor ? undefined : ledger, // only on first page
      filters: [{ type: "contract" }],
      limit: PAGE_LIMIT,
      ...(pageCursor ? { cursor: pageCursor } : {}),
    };

    const res = await withRetry(() => rpc.getEvents(req));
    latestLedger = res.latestLedger ?? latestLedger;
    latestLedgerHash = res.latestLedgerHash ?? latestLedgerHash;

    const pageEvents =
      endLedger == null
        ? res.events
        : res.events.filter((event) => Number(event.ledger) >= ledger && Number(event.ledger) <= endLedger);
    const beyondEndLedger = endLedger != null && res.events.some((event) => Number(event.ledger) > endLedger);

    // Flag footprint contention across transactions in this page's events
    scanFootprintContention(pageEvents);

    // Build a per-page transaction-context cache to avoid redundant RPC calls
    // when multiple events share the same transaction.
    const transactionContextCache = new Map();
    const uniqueTxHashes = [...new Set(pageEvents.map((e) => e.txHash).filter(Boolean))];
    await Promise.all(
      uniqueTxHashes.map(async (txHash) => {
        transactionContextCache.set(
          txHash,
          await loadTransactionContext(txHash, {
            ...(suppressExternalEffects ? { publishStatus: () => {} } : {}),
          }),
        );
      }),
    );

    // One lineage batch per RPC page (#945); lineage failures never block ingest.
    const lineage = res.events.length
      ? await startLineageBatch({
          runType: "live",
          source: RPC_URL,
          ledgerFrom: Math.min(...res.events.map((e) => e.ledger)),
          ledgerTo: Math.max(...res.events.map((e) => e.ledger)),
        }).catch((err) => logger.error("[lineage] batch start failed:", err.message))
      : null;

    const ingestPipeline = createIngestPipeline({
      concurrency: INGEST_CONCURRENCY,
      batchSize: INGEST_BATCH_SIZE,
      maxQueue: INGEST_MAX_QUEUE,
      processBatch: async (batch) => {
        await processEventBatch(batch, transactionContextCache, lineage?.id ?? null);
      },
    });

    const { accepted, dropped } = ingestPipeline.enqueue(res.events);
    if (dropped > 0) {
      logger.warn(
        { ledger, dropped, accepted, total: res.events.length, maxQueue: INGEST_MAX_QUEUE },
        "ingest queue overflow: shed events to protect lag budget",
      );
    }
    await ingestPipeline.drain();

    // Purge the CDN entries this page changed: "latest" lists plus every
    // contract it touched (debounced/batched in cdnPurge.js).
    if (res.events.length) {
      enqueuePurge(["latest", ...new Set(res.events.map((e) => `contract:${e.contractId}`).filter((k) => k !== "contract:undefined"))]);
    }

    // Scan transactions for UploadContractWasm operations (non-blocking)
    if (endLedger == null) {
      indexWasmUploads(uniqueTxHashes, ledger).catch((err) => logger.error("[wasmUpload] batch error:", err.message));
    }

    // record the latest ledger hash for re-org detection
    if (endLedger == null && res.latestLedger && res.latestLedgerHash) {
      await recordLedgerHash(res.latestLedger, res.latestLedgerHash).catch(() => {});
    }

    // If the RPC returned a full page there may be more events; follow the cursor.
    pageCursor = !beyondEndLedger && res.events.length === PAGE_LIMIT ? res.cursor : undefined;
    if (pageCursor && pageDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, pageDelayMs));
  } while (pageCursor);

  // Invalidate events list cache after each ledger so stale pages are evicted.
  if (latestLedger > ledger) {
    cacheInvalidate("events:list:*").catch(() => {});
    cacheInvalidate("rpc:ledger-entries:*").catch(() => {});
    cacheInvalidate("rpc:simulation:*").catch(() => {});
  }

  return { latestLedger, latestLedgerHash, eventsProcessed };
}

function assertLeadership() {
  if (LEADERSHIP_ENABLED && !isLeader()) {
    const error = new Error("Indexer leadership lost");
    error.code = "LEADERSHIP_LOST";
    throw error;
  }
}

let shutdown = false;
let ledgersSinceReorgCheck = 0;

// Deployable role (#935): "ingest" polls RPC, "api" only serves HTTP/WS,
// "workers" runs background jobs, "all" (default) runs everything in one process.
const INDEXER_ROLE = (process.env.INDEXER_ROLE || "all").toLowerCase();
const RUNS_INGEST = INDEXER_ROLE === "all" || INDEXER_ROLE === "ingest";
const RUNS_WORKERS = INDEXER_ROLE === "all" || INDEXER_ROLE === "workers";
// Time to keep serving after SIGTERM so endpoints deregister before close.
// Redis-lease leader election so only one ingest pod writes at a time.
const LEADERSHIP_ENABLED = process.env.LEADER_ELECTION_ENABLED === "true";
const DRAIN_MS = Number(process.env.SHUTDOWN_DRAIN_MS ?? 10_000);

async function run() {
  // Fail fast if the secrets provider (Vault/KMS) is unreachable at boot (#929).
  await initSecrets();
  await db.init();
  // Resumable: re-wraps only rows not yet on the current KEK.
  rotateWebhookSecrets(pool).catch((err) => logger.warn(`[secrets] webhook secret rotation failed: ${err.message}`));
  if (LEADERSHIP_ENABLED && RUNS_INGEST) {
    await tryAcquireLock();
    startLeaderElection({
      onBecomeLeader: () => logger.info("[leaderElection] this instance is now indexing"),
      onLoseLeadership: () => logger.warn("[leaderElection] indexing paused after lease loss"),
    });
  }
  if (config.SEED_BUILTIN_ABIS) {
    await seedBuiltinAbis().catch((err) => logger.warn({ err: err.message }, "built-in ABI seeding failed"));
  }
  void runIntegrityChecks()
    .then((result) => {
      if (result.ok) {
        logger.info("startup integrity check passed");
      } else {
        logger.warn({ failed: result.failed }, "startup integrity check failed");
      }
    })
    .catch((err) => logger.warn({ err: err.message }, "startup integrity check failed to run"));
  const server = startApi();
  // Poll DB pool stats every 15 s for Prometheus gauges
  setInterval(() => updateDbPoolMetrics(pool), 15_000);
  warmCache().catch((e) => logger.warn({ err: e.message }, "cache warm failed"));

  if (!RUNS_INGEST && !RUNS_WORKERS) {
    logger.info({ role: INDEXER_ROLE }, "api-only role; ingest and workers disabled");
    while (!shutdown) await new Promise((r) => setTimeout(r, 1_000));
    return drainAndExit(server);
  }
  if (!RUNS_WORKERS) return runIngest(server);

  seedBuiltinAbis().catch((e) => logger.warn({ err: e.message }, "builtin ABI seed failed"));
  startAbiSync();
  initRuntimeConfig(pool).catch((err) => logger.error("[runtimeConfig] init failed:", err.message)); // hot-reloadable config (#894)
  startContractVerifier(); // periodically verify DB ABI hashes against on-chain registry
  startQueryJobMaintenance().catch((err) => logger.error("[jobs] startup failed:", err.message)); // async query jobs (#906)
  startBurnDetector();
  startMetricsCollector(); // RPC latency probes
  startNodeRecoveryPoll(); // re-check unhealthy multi-node RPC failover nodes
  startPruner(); // daily temporary-storage cleanup
  startGasGuzzlersWorker(); // daily gas consumption leaderboard
  startReDecodeWorker(); // low-priority ABI refresh for superseded events
  startOutboxRelay(); // post-commit WS/SSE/webhook fan-out

  // ── Auth & Rate Limiting cron jobs ─────────────────────────────────────────
  startUsageFlushCron(); // flush Redis usage counters → DB every minute
  startRetentionCleanupCron(); // nightly usage data retention cleanup
  startAuditPartitionCron(); // monthly audit log partition management
  startAuditFlush(); // drain queued audit log entries every 500ms
  startUptimeRecorder(); // sample /health every 5 minutes for the status page

  // Bootstrap vault indexer: initial ratio snapshot for all registered vaults
  refreshAllVaults().catch(() => {});
  // Periodic ratio refresh + alert health checks every 60 s
  setInterval(() => {
    refreshAllVaults().catch(() => {});
    alertManager.checkIndexerDown().catch(() => {});
    alertManager.checkResourceConstraints().catch(() => {});
    alertManager.checkDecodeRate(getDecodeStats().success_rate).catch(() => {});
    // Route webhook-delivery retries and normal ledger-event retries to their
    // respective handlers (see dlqRetryDispatch).
    dlqProcessRetries(dlqRetryDispatch).catch(() => {}); // retry transient failures
    getDlqDepth()
      .then((depth) => {
        dlqDepth.set(depth);
        updateDlqDepth(depth);
        return alertManager.checkDlqSize(depth);
      })
      .catch((err) => logger.error({ err: err.message }, "dlq depth check failed"));
    refreshDlqHealth().catch((err) => logger.error({ err: err.message }, "dlq health check failed"));
  }, 60_000);

  if (!RUNS_INGEST) {
    logger.info({ role: INDEXER_ROLE }, "workers role; ingest disabled");
    while (!shutdown) await new Promise((r) => setTimeout(r, 1_000));
    return drainAndExit(server);
  }
  return runIngest(server);
}

async function runIngest(server) {

  // Resume from the durable cursor. Legacy databases without one replay the
  // highest indexed ledger so a partially written ledger is not skipped.
  const savedCursor = await db.loadCursor();
  const dbMax = savedCursor == null || savedCursor <= 0 ? await db.getMaxLedger() : 0;
  const initialCursor =
    START_LEDGER || (await withRetry(() => multiNodeRpc.getLatestLedger())).sequence - 100;
  _cursor = resolveStartupCursor(savedCursor, dbMax, initialCursor);
  await db.saveCursor(_cursor);

  logger.info({ ledger: _cursor }, "daemon starting");

  while (!shutdown) {
    if (LEADERSHIP_ENABLED && !isLeader()) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      continue;
    }
    try {
      // ── drain gap queue first ──────────────────────────────────────
      while (_gapQueue.length > 0 && !shutdown) {
        assertLeadership();
        const gap = _gapQueue[0];
        logger.info(
          `[gap] re-indexing ledgers ${gap.from} → ${gap.to} (attempt ${gap.retries + 1}/${MAX_GAP_RETRIES})`,
        );
        let gapOk = true;
        for (let ledger = gap.from; ledger <= gap.to; ledger++) {
          if (shutdown) break;
          try {
            assertLeadership();
            await indexLedger(ledger);
            gapRecordLedger(ledger);
          } catch (err) {
            if (err.code === "LEADERSHIP_LOST") break;
            logger.error({ err: err.message, ledger }, "gap re-index failed");
            gapOk = false;
            break;
          }
        }

        if (LEADERSHIP_ENABLED && !isLeader()) break;
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
      logger.info(`[daemon] polling from ledger ${_cursor}`);
      const polledFrom = _cursor;
      const latest = await indexLedger(polledFrom);
      assertLeadership();
      const latestLedger = latest.latestLedger ?? polledFrom;
      const latestLedgerHash = latest.latestLedgerHash;
      alertManager.recordPoll();
      gapRecordLedger(polledFrom);
      const lagSeconds = Math.floor((Date.now() - polledFrom * 5000) / 1000); // approximate lag
      const ledgerLag = Math.max(0, latestLedger - polledFrom);
      updateIndexerStatus(polledFrom, lagSeconds, ledgerLag);
      indexerLagLedgers.set(ledgerLag);

      assertLeadership();
      const immediateForkLedger = await checkForReorg(latestLedger, latestLedgerHash, { rpc }).catch((err) => {
        logger.error({ err: err.message, ledger: latestLedger }, "reorg fast-path check failed");
        return null;
      });
      if (immediateForkLedger !== null) {
        _cursor = immediateForkLedger;
        logger.warn({ ledger: immediateForkLedger }, "chain reorganization detected; cursor rewound");
        continue;
      }

      ledgersSinceReorgCheck += Math.max(1, latestLedger - polledFrom + 1);
      if (ledgersSinceReorgCheck >= REORG_CHECK_INTERVAL) {
        // Keep reorg handling in this single-flight loop so no timer can race
        // indexLedger() while it owns and persists the daemon cursor.
        // The raw ledger span only triggers the check. Hash-row lookback stays
        // bounded inside checkForReorg(), even after a large catch-up jump.
        const forkLedger = await checkForReorg(rpc);
        assertLeadership();
        ledgersSinceReorgCheck = 0;
        if (forkLedger !== null) {
          // rollbackFromLedger() persisted this rewind in the same transaction
          // that removed orphaned rows; only the in-memory cursor remains.
          _cursor = forkLedger;
          logger.warn({ ledger: forkLedger }, "chain reorganization detected; cursor rewound");
          continue;
        }
      }

      _cursor = latestLedger + 1;
      await db.saveCursor(_cursor);
      await db.saveLastIndexedLedger(latestLedger);
    } catch (err) {
      if (err.code === "LEADERSHIP_LOST") {
        logger.info("[leaderElection] interrupted ledger work; cursor was not advanced");
      } else {
        logger.error({ err: err.message, ledger: _cursor }, "indexer error");
        rpcErrors.inc({ type: err.code ?? "unknown" });
        await alertManager.checkRpcHealth(false);
      }
    }
    if (!shutdown) await new Promise((r) => setTimeout(r, POLL_MS));
  }

  logger.info("daemon shutting down");
  if (LEADERSHIP_ENABLED) await stopLeaderElection();
  return drainAndExit(server);
}

// Fail readiness, keep serving in-flight requests for DRAIN_MS, then close.
async function drainAndExit(server) {
  setDraining(true);
  if (server && DRAIN_MS > 0) await new Promise((r) => setTimeout(r, DRAIN_MS));
  server?.close();
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.on("SIGTERM", () => {
    shutdown = true;
    logger.info("SIGTERM received");
  });
  process.on("SIGINT", () => {
    shutdown = true;
    logger.info("SIGINT received");
  });

  run();
}
