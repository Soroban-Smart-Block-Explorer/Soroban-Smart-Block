/* global fetch */

/**
 * Issue #209 — Alert Manager
 *
 * Monitors 8 alert conditions and routes notifications to Slack and PagerDuty.
 *
 * Conditions:
 *   1. INDEXER_DOWN        — indexer not polling within expected interval
 *   2. LEDGER_GAP          — gap exceeding threshold ledgers detected
 *   3. DB_FAILURE          — database errors above threshold
 *   4. RESOURCE_CONSTRAINT — process heap exceeding configured limit
 *   5. ALL_RPC_DOWN        — all configured RPC providers are unhealthy
 *   6. LOW_THROUGHPUT      — indexing rate below minimum threshold
 *   7. DLQ_THRESHOLD       — dead-letter-queue size exceeds maximum
 *   8. REORG_DETECTED      — chain reorganization detected (ledger hash mismatch)
 */

import config from "./config.js";

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL ?? "";
const PAGERDUTY_ROUTING_KEY = process.env.PAGERDUTY_ROUTING_KEY ?? "";
const PAGERDUTY_EVENTS_URL = "https://events.pagerduty.com/v2/enqueue";

const GAP_THRESHOLD = config.ALERT_GAP_THRESHOLD;
const DLQ_MAX_SIZE = config.ALERT_DLQ_MAX_SIZE;
const MIN_THROUGHPUT = config.ALERT_MIN_THROUGHPUT;
const MAX_HEAP_MB = config.ALERT_MAX_HEAP_MB;
const INDEXER_STALL_MS = config.ALERT_INDEXER_STALL_MS;

export const ALERT_CONDITIONS = {
  INDEXER_DOWN: "INDEXER_DOWN",
  LEDGER_GAP: "LEDGER_GAP",
  DB_FAILURE: "DB_FAILURE",
  RESOURCE_CONSTRAINT: "RESOURCE_CONSTRAINT",
  ALL_RPC_DOWN: "ALL_RPC_DOWN",
  LOW_THROUGHPUT: "LOW_THROUGHPUT",
  DLQ_THRESHOLD: "DLQ_THRESHOLD",
  REORG_DETECTED: "REORG_DETECTED",
};

const SEVERITY = {
  [ALERT_CONDITIONS.INDEXER_DOWN]: "critical",
  [ALERT_CONDITIONS.LEDGER_GAP]: "warning",
  [ALERT_CONDITIONS.DB_FAILURE]: "critical",
  [ALERT_CONDITIONS.RESOURCE_CONSTRAINT]: "warning",
  [ALERT_CONDITIONS.ALL_RPC_DOWN]: "critical",
  [ALERT_CONDITIONS.LOW_THROUGHPUT]: "warning",
  [ALERT_CONDITIONS.DLQ_THRESHOLD]: "warning",
  [ALERT_CONDITIONS.REORG_DETECTED]: "critical",
};

// Active alert state — maps condition → timestamp when first fired
const _active = new Map();

let _lastPollAt = Date.now();

// ── Notification helpers ──────────────────────────────────────────────────────

async function sendSlack(condition, message) {
  if (!SLACK_WEBHOOK_URL) return;
  try {
    const severity = SEVERITY[condition] ?? "warning";
    const emoji = severity === "critical" ? ":red_circle:" : ":warning:";
    await fetch(SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `${emoji} *[${condition}]* ${message}` }),
    });
  } catch (err) {
    console.error(`[alertManager] Slack webhook failed: ${err.message}`);
  }
}

async function sendPagerDuty(condition, message) {
  if (!PAGERDUTY_ROUTING_KEY) return;
  try {
    await fetch(PAGERDUTY_EVENTS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        routing_key: PAGERDUTY_ROUTING_KEY,
        event_action: "trigger",
        dedup_key: condition,
        payload: {
          summary: `[soroban-indexer] ${condition}: ${message}`,
          source: "soroban-indexer",
          severity: SEVERITY[condition] ?? "warning",
        },
      }),
    });
  } catch (err) {
    console.error(`[alertManager] PagerDuty API failed: ${err.message}`);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fire an alert for a given condition.
 * Deduplicates: repeated calls for the same active condition are suppressed.
 *
 * @param {string} condition  One of ALERT_CONDITIONS
 * @param {string} message    Human-readable detail
 */
export async function fireAlert(condition, message) {
  if (_active.has(condition)) return;
  _active.set(condition, Date.now());
  console.warn(`[alertManager] ALERT ${condition}: ${message}`);
  await Promise.all([sendSlack(condition, message), sendPagerDuty(condition, message)]);
}

/**
 * Resolve (clear) an active alert condition.
 *
 * @param {string} condition
 */
export function resolveAlert(condition) {
  if (_active.has(condition)) {
    _active.delete(condition);
    console.log(`[alertManager] RESOLVED ${condition}`);
  }
}

/** Return the list of currently active alert conditions with their durations. */
export function getActiveAlerts() {
  const now = Date.now();

  return Array.from(_active.entries()).map(([condition, firedAt]) => ({
    condition,
    firedAt: new Date(firedAt).toISOString(),
    durationMs: Math.max(0, now - firedAt),
  }));
}

// ── Condition checkers ────────────────────────────────────────────────────────

/** Called by the indexer main loop after each successful poll. */
export function recordPoll() {
  _lastPollAt = Date.now();
  resolveAlert(ALERT_CONDITIONS.INDEXER_DOWN);
}

/** Check whether the indexer has stalled (not polled within INDEXER_STALL_MS). */
export async function checkIndexerDown() {
  if (Date.now() - _lastPollAt > INDEXER_STALL_MS) {
    await fireAlert(ALERT_CONDITIONS.INDEXER_DOWN, `No successful poll in ${INDEXER_STALL_MS}ms`);
  }
}

/**
 * Check for a ledger gap condition.
 *
 * @param {number} gapSize     Number of consecutive missing ledgers
 * @param {number} fromLedger  Start ledger of the gap
 */
export async function checkLedgerGap(gapSize, fromLedger) {
  if (gapSize > GAP_THRESHOLD) {
    await fireAlert(
      ALERT_CONDITIONS.LEDGER_GAP,
      `Gap of ${gapSize} ledgers starting at ${fromLedger} (threshold=${GAP_THRESHOLD})`,
    );
  } else {
    resolveAlert(ALERT_CONDITIONS.LEDGER_GAP);
  }
}

/**
 * Check database health.
 *
 * @param {boolean} healthy
 */
export async function checkDbHealth(healthy) {
  if (!healthy) {
    await fireAlert(ALERT_CONDITIONS.DB_FAILURE, "Database connection failure");
  } else {
    resolveAlert(ALERT_CONDITIONS.DB_FAILURE);
  }
}

/** Check process heap usage against MAX_HEAP_MB. */
export async function checkResourceConstraints() {
  const heapMb = process.memoryUsage().heapUsed / 1024 / 1024;
  if (heapMb > MAX_HEAP_MB) {
    await fireAlert(
      ALERT_CONDITIONS.RESOURCE_CONSTRAINT,
      `Heap usage ${heapMb.toFixed(1)} MB exceeds limit of ${MAX_HEAP_MB} MB`,
    );
  } else {
    resolveAlert(ALERT_CONDITIONS.RESOURCE_CONSTRAINT);
  }
}

/**
 * Check whether all RPC providers are unhealthy.
 *
 * @param {boolean} anyHealthy  True if at least one provider is reachable
 */
export async function checkRpcHealth(anyHealthy) {
  if (!anyHealthy) {
    await fireAlert(ALERT_CONDITIONS.ALL_RPC_DOWN, "All configured RPC providers are unreachable");
  } else {
    resolveAlert(ALERT_CONDITIONS.ALL_RPC_DOWN);
  }
}

/**
 * Check indexing throughput.
 *
 * @param {number} eventsPerMin  Measured events processed per minute
 */
export async function checkThroughput(eventsPerMin) {
  if (eventsPerMin < MIN_THROUGHPUT) {
    await fireAlert(
      ALERT_CONDITIONS.LOW_THROUGHPUT,
      `Throughput ${eventsPerMin} events/min is below minimum ${MIN_THROUGHPUT}`,
    );
  } else {
    resolveAlert(ALERT_CONDITIONS.LOW_THROUGHPUT);
  }
}

/**
 * Check dead letter queue size.
 *
 * @param {number} size  Current number of unresolved DLQ entries
 */
export async function checkDlqSize(size) {
  if (size > DLQ_MAX_SIZE) {
    await fireAlert(ALERT_CONDITIONS.DLQ_THRESHOLD, `DLQ has ${size} unresolved entries (max=${DLQ_MAX_SIZE})`);
  } else {
    resolveAlert(ALERT_CONDITIONS.DLQ_THRESHOLD);
  }
}

/**
 * Fire a reorg alert when a ledger hash mismatch is detected.
 *
 * @param {number} ledger  Ledger sequence at which the reorg was detected
 */
export async function alertReorg(ledger) {
  await fireAlert(ALERT_CONDITIONS.REORG_DETECTED, `Chain reorganization detected at ledger ${ledger}`);
}
