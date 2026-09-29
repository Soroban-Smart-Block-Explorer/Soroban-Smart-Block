import { logger } from "./logger.js";
/**
 * Issue #209 — Dead Letter Queue (DLQ)
 *
 * Events that fail indexing after all retry attempts are enqueued here.
 * Transient-error events are automatically retried with exponential backoff.
 * Provides a programmatic API for admin review and manual replay.
 */

import crypto from "node:crypto";
import { db } from "./db.js";
import config from "./config.js";
import { fireAlert, resolveAlert, ALERT_CONDITIONS } from "./alertManager.js";
import { dlqDepthByState, dlqReplayedTotal, dlqQuarantinedTotal } from "./metrics.js";

const DLQ_RETRY_DELAY_MS = config.DLQ_RETRY_DELAY_MS;
const DLQ_BACKOFF_BASE = config.DLQ_BACKOFF_BASE;
const DLQ_BACKOFF_MAX_MS = config.DLQ_BACKOFF_MAX_MS;
const DLQ_MAX_ATTEMPTS = config.DLQ_MAX_ATTEMPTS;
const DLQ_POISON_THRESHOLD = config.DLQ_POISON_THRESHOLD;
const DLQ_ALERT_AGE = config.DLQ_ALERT_AGE;
const DLQ_BATCH_SIZE = config.DLQ_BATCH_SIZE;
const REPLAY_CHUNK = 500;
// A `retrying` claim older than this is assumed orphaned (crashed worker / DB
// outage mid-write) and becomes claimable again — no entry is ever lost.
const STALE_CLAIM_MS = 10 * 60_000;

export const DLQ_STATES = ["queued", "retrying", "quarantined", "resolved"];

/**
 * Classify whether an error message indicates a transient failure
 * eligible for automatic retry.
 *
 * @param {string} errorMessage
 * @returns {boolean}
 */
export function isTransientError(errorMessage) {
  return /timeout|rate\s*limit|too\s*many\s*requests|econnreset|etimedout|network/i.test(errorMessage);
}

/**
 * Compute the backoff delay for a given retry attempt.
 *
 * @param {number} retryCount  0-based retry number
 * @returns {number} delay in milliseconds
 */
export function computeNextRetryDelay(retryCount) {
  return DLQ_RETRY_DELAY_MS * Math.pow(2, retryCount);
}

/**
 * Issue #851 — exponential backoff for the processor, capped at
 * DLQ_BACKOFF_MAX_MS.
 *
 * @param {number} attempts  attempts made so far (>= 1)
 * @param {{ base?: number, max?: number }} [opts]
 * @returns {number} delay in milliseconds
 */
export function computeBackoff(attempts, { base = DLQ_BACKOFF_BASE, max = DLQ_BACKOFF_MAX_MS } = {}) {
  return Math.min(max, base * Math.pow(2, Math.max(0, attempts - 1)));
}

/**
 * Classify an error into an error class and a stable stack hash. The hash
 * covers the error class and the stack frames (not the message, which often
 * embeds ids), so the same bug hit by different payloads hashes identically.
 *
 * @param {Error|{name?:string,message?:string,stack?:string}} err
 * @returns {{ errorClass: string, stackHash: string }}
 */
export function classifyError(err) {
  const errorClass = err?.name && err.name !== "Error" ? err.name : err?.constructor?.name || "Error";
  const frames = String(err?.stack ?? "")
    .split("\n")
    .filter((l) => l.trim().startsWith("at "))
    .slice(0, 5) // innermost frames identify the failing code path
    .map((l) => l.trim())
    .join("\n");
  const basis = frames || String(err?.message ?? "").replace(/\d+/g, "#");
  const stackHash = crypto.createHash("sha256").update(`${errorClass}\n${basis}`).digest("hex").slice(0, 16);
  return { errorClass, stackHash };
}

/**
 * Decide the state of an entry after a failed replay.
 *
 * @param {{ attempts: number, sameHashCount: number, maxAttempts?: number, poisonThreshold?: number }} p
 * @returns {"quarantined"|"queued"}
 */
export function nextStateAfterFailure({
  attempts,
  sameHashCount,
  maxAttempts = DLQ_MAX_ATTEMPTS,
  poisonThreshold = DLQ_POISON_THRESHOLD,
}) {
  if (attempts >= maxAttempts) return "quarantined";
  if (sameHashCount >= poisonThreshold) return "quarantined";
  return "queued";
}

/** True when the failure means the payload can never succeed (contract deleted). */
function isContractGone(err) {
  return err?.code === "CONTRACT_DELETED" || err?.code === "CONTRACT_NOT_FOUND";
}

/**
 * Initialise the dead_letter_queue functionality.
 * 
 * Note: The table creation is now handled by migration 010_dead_letter_queue.sql
 * This function is kept as a no-op for backwards compatibility but will be
 * removed in a future version once all references are cleaned up.
 */
export async function initDeadLetterQueue() {
  // No-op: table creation moved to migration system (010_dead_letter_queue.sql)
}

/**
 * Enqueue a failed event into the dead letter queue.
 *
 * @param {object} rawEvent  The raw event object that failed processing
 * @param {Error}  error     The error that caused the failure
 * @returns {Promise<number>} The new DLQ entry id
 */
export async function enqueue(rawEvent, error) {
  const transient = isTransientError(error.message);
  const { errorClass, stackHash } = classifyError(error);
  // Issue #851: every entry is auto-replayed; deterministic failures end up
  // quarantined after DLQ_MAX_ATTEMPTS instead of being silently parked.
  const nextRetryAt = new Date(Date.now() + computeBackoff(1)).toISOString();

  const { rows } = await db.query(
    `INSERT INTO dead_letter_queue
       (event_id, contract_id, ledger, tx_hash, raw_event, error_message, error_code, max_retries, next_retry_at,
        state, error_class, stack_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'queued', $10, $11)
     RETURNING id`,
    [
      rawEvent.id ?? null,
      rawEvent.contractId ?? rawEvent.contract_id ?? null,
      rawEvent.ledger ?? null,
      rawEvent.txHash ?? rawEvent.tx_hash ?? null,
      JSON.stringify(rawEvent),
      error.message,
      error.code ?? null,
      DLQ_MAX_ATTEMPTS,
      nextRetryAt,
      errorClass,
      stackHash,
    ],
  );

  const id = rows[0].id;
  logger.warn(`[dlq] enqueued entry id=${id} transient=${transient} class=${errorClass} error="${error.message}"`);
  return id;
}

/**
 * Mark an entry resolved.
 */
async function markResolved(id, reason = null) {
  await db.query(
    `UPDATE dead_letter_queue
     SET state = 'resolved', resolved = TRUE, resolved_reason = $2, next_retry_at = NULL, updated_at = NOW()
     WHERE id = $1`,
    [id, reason],
  );
}

/**
 * Record a failed attempt; quarantines the entry (and, on poison detection,
 * every open entry sharing its stack hash).
 *
 * @returns {Promise<"quarantined"|"queued">}
 */
async function recordFailure(entry, err) {
  const attempts = entry.retry_count + 1;
  const { errorClass, stackHash } = classifyError(err);
  const { rows } = await db.query(
    `SELECT COUNT(*)::INT AS n FROM dead_letter_queue WHERE stack_hash = $1 AND state <> 'resolved'`,
    [stackHash],
  );
  const state = nextStateAfterFailure({ attempts, sameHashCount: rows[0].n });
  const nextRetry = state === "queued" ? new Date(Date.now() + computeBackoff(attempts)).toISOString() : null;
  await db.query(
    `UPDATE dead_letter_queue
     SET retry_count = $1, next_retry_at = $2, error_message = $3, error_class = $4, stack_hash = $5,
         state = $6, updated_at = NOW()
     WHERE id = $7`,
    [attempts, nextRetry, err.message, errorClass, stackHash, state, entry.id],
  );

  if (state === "quarantined") {
    // Group quarantine: the same bug across many entries is a poison message.
    const { rowCount } = await db.query(
      `UPDATE dead_letter_queue SET state = 'quarantined', next_retry_at = NULL, updated_at = NOW()
       WHERE stack_hash = $1 AND state IN ('queued', 'retrying') AND id <> $2`,
      [stackHash, entry.id],
    );
    const total = 1 + (rowCount ?? 0);
    dlqQuarantinedTotal.inc(total);
    logger.warn(`[dlq] quarantined ${total} entr${total === 1 ? "y" : "ies"} class=${errorClass} hash=${stackHash}`);
    await fireAlert(
      ALERT_CONDITIONS.DLQ_QUARANTINE,
      `${total} DLQ entr${total === 1 ? "y" : "ies"} quarantined (${errorClass}: ${err.message})`,
    );
  }
  return state;
}

/**
 * Process all DLQ entries that are due for automatic retry.
 *
 * Entries are claimed atomically (`FOR UPDATE SKIP LOCKED`) so two processor
 * instances never replay the same entry. At most DLQ_BATCH_SIZE entries are
 * replayed per tick, sequentially, so live indexing is never starved.
 * Handlers are idempotent on event_uid, so replaying an entry that already
 * succeeded is a no-op.
 *
 * @param {Function} handler  async (rawEvent: object) => void
 * @returns {Promise<{ retried: number, resolved: number, failed: number, quarantined: number }>}
 */
export async function processRetries(handler) {
  const { rows } = await db.query(
    `UPDATE dead_letter_queue SET state = 'retrying', updated_at = NOW()
     WHERE id IN (
       SELECT id FROM dead_letter_queue
       WHERE (state = 'queued' AND next_retry_at IS NOT NULL AND next_retry_at <= NOW())
          OR (state = 'retrying' AND updated_at < NOW() - ($1 || ' milliseconds')::INTERVAL)
       ORDER BY next_retry_at ASC NULLS FIRST
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
    [String(STALE_CLAIM_MS), DLQ_BATCH_SIZE],
  );

  let retried = 0;
  let resolved = 0;
  let failed = 0;
  let quarantined = 0;

  for (const entry of rows) {
    retried++;
    try {
      await handler(entry.raw_event);
      await markResolved(entry.id);
      dlqReplayedTotal.inc();
      resolved++;
      logger.info(`[dlq] entry id=${entry.id} resolved on attempt ${entry.retry_count + 1}`);
    } catch (err) {
      if (isContractGone(err)) {
        await markResolved(entry.id, "contract deleted");
        resolved++;
        continue;
      }
      failed++;
      // If this write fails (DB down) the entry simply stays `retrying` and is
      // re-claimed after STALE_CLAIM_MS.
      const state = await recordFailure(entry, err);
      if (state === "quarantined") quarantined++;
      logger.warn(`[dlq] entry id=${entry.id} attempt ${entry.retry_count + 1} failed: ${err.message} → ${state}`);
    }
  }

  return { retried, resolved, failed, quarantined };
}

/**
 * Refresh indexer_dlq_depth{state} and fire the oldest-entry-age alert.
 *
 * @returns {Promise<Record<string, number>>} depth per state
 */
export async function refreshDlqHealth() {
  const { rows } = await db.query(
    `SELECT state, COUNT(*)::INT AS n,
            EXTRACT(EPOCH FROM (NOW() - MIN(created_at))) * 1000 AS oldest_ms
     FROM dead_letter_queue GROUP BY state`,
  );
  const depth = Object.fromEntries(DLQ_STATES.map((st) => [st, 0]));
  let oldestOpenMs = 0;
  for (const r of rows) {
    depth[r.state] = r.n;
    if (r.state !== "resolved") oldestOpenMs = Math.max(oldestOpenMs, Number(r.oldest_ms) || 0);
  }
  for (const st of DLQ_STATES) dlqDepthByState.set({ state: st }, depth[st]);

  if (oldestOpenMs > DLQ_ALERT_AGE) {
    await fireAlert(ALERT_CONDITIONS.DLQ_STALE, `Oldest open DLQ entry is ${Math.round(oldestOpenMs / 1000)}s old`);
  } else {
    resolveAlert(ALERT_CONDITIONS.DLQ_STALE);
  }
  if (depth.quarantined === 0) resolveAlert(ALERT_CONDITIONS.DLQ_QUARANTINE);
  return depth;
}

/**
 * Retrieve DLQ entries for the admin UI.
 *
 * @param {{ page?: number, limit?: number, resolved?: boolean, state?: string, errorClass?: string }} opts
 * @returns {Promise<{ data: object[], total: number }>}
 */
export async function getItems({ page = 1, limit = 25, resolved = false, state, errorClass } = {}) {
  const offset = (page - 1) * limit;
  const where = [];
  const params = [];
  if (state) {
    params.push(state);
    where.push(`state = $${params.length}`);
  } else {
    params.push(resolved);
    where.push(`resolved = $${params.length}`);
  }
  if (errorClass) {
    params.push(errorClass);
    where.push(`error_class = $${params.length}`);
  }
  const clause = `WHERE ${where.join(" AND ")}`;
  const [{ rows }, { rows: countRows }] = await Promise.all([
    db.query(
      `SELECT id, event_id, contract_id, ledger, tx_hash, error_message, error_code, error_class, stack_hash,
              state, resolved_reason, retry_count, max_retries, next_retry_at, resolved, created_at, updated_at
       FROM dead_letter_queue
       ${clause}
       ORDER BY created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    ),
    db.query(`SELECT COUNT(*)::INT AS total FROM dead_letter_queue ${clause}`, params),
  ]);
  return { data: rows, total: countRows[0].total };
}

/**
 * Current count of unresolved DLQ entries, for the dlq_depth gauge and the
 * `dlq.depth` field on GET /api/health.
 *
 * @returns {Promise<number>}
 */
export async function getDlqDepth() {
  const { rows } = await db.query(`SELECT COUNT(*)::INT AS count FROM dead_letter_queue WHERE state <> 'resolved'`);
  return rows[0].count;
}

/**
 * Mark a DLQ entry as manually resolved.
 *
 * @param {number} id
 */
export async function resolve(id, reason = "manually resolved") {
  await markResolved(id, reason);
  logger.info(`[dlq] entry id=${id} manually resolved`);
}

/**
 * Re-queue open (queued/quarantined) entries of one error class for immediate
 * replay. Updates run in chunks; the processor then drains them at
 * DLQ_BATCH_SIZE per tick, which rate-limits the replay.
 *
 * @param {string} errorClass
 * @param {{ signal?: AbortSignal }} [opts]  abort to cancel between chunks
 * @returns {Promise<number>} entries re-queued
 */
export async function requeueByErrorClass(errorClass, { signal } = {}) {
  let total = 0;
  while (!signal?.aborted) {
    const { rowCount } = await db.query(
      `UPDATE dead_letter_queue SET state = 'queued', retry_count = 0, next_retry_at = NOW(), updated_at = NOW()
       WHERE id IN (
         SELECT id FROM dead_letter_queue
         WHERE error_class = $1 AND state IN ('queued', 'quarantined')
           AND (next_retry_at IS NULL OR next_retry_at > NOW())
         LIMIT $2
       )`,
      [errorClass, REPLAY_CHUNK],
    );
    total += rowCount ?? 0;
    if (!rowCount || rowCount < REPLAY_CHUNK) break;
  }
  logger.info(`[dlq] re-queued ${total} entries with error_class=${errorClass}`);
  return total;
}

/**
 * Manually replay a specific DLQ entry through the indexing handler.
 *
 * @param {number}   id
 * @param {Function} handler  async (rawEvent: object) => void
 */
export async function replay(id, handler) {
  const { rows } = await db.query(`SELECT * FROM dead_letter_queue WHERE id = $1`, [id]);
  if (!rows.length) throw new Error(`[dlq] entry id=${id} not found`);

  const entry = rows[0];
  try {
    await handler(entry.raw_event);
    await markResolved(id);
    dlqReplayedTotal.inc();
    logger.info(`[dlq] entry id=${id} replayed successfully`);
  } catch (err) {
    await db.query(
      `UPDATE dead_letter_queue
       SET retry_count = retry_count + 1, error_message = $1, updated_at = NOW()
       WHERE id = $2`,
      [err.message, id],
    );
    throw err;
  }
}
