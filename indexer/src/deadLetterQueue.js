/**
 * Issue #209 — Dead Letter Queue (DLQ)
 *
 * Events that fail indexing after all retry attempts are enqueued here.
 * Transient-error events are automatically retried with exponential backoff.
 * Provides a programmatic API for admin review and manual replay.
 */

import { db } from "./db.js";
import config from "./config.js";

const DLQ_MAX_RETRIES = config.DLQ_MAX_RETRIES;
const DLQ_RETRY_DELAY_MS = config.DLQ_RETRY_DELAY_MS;

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
  const maxRetries = transient ? DLQ_MAX_RETRIES : 0;
  const nextRetryAt = transient ? new Date(Date.now() + DLQ_RETRY_DELAY_MS).toISOString() : null;

  const { rows } = await db.query(
    `INSERT INTO dead_letter_queue
       (event_id, contract_id, ledger, tx_hash, raw_event, error_message, error_code, max_retries, next_retry_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      rawEvent.id ?? null,
      rawEvent.contractId ?? rawEvent.contract_id ?? null,
      rawEvent.ledger ?? null,
      rawEvent.txHash ?? rawEvent.tx_hash ?? null,
      JSON.stringify(rawEvent),
      error.message,
      error.code ?? null,
      maxRetries,
      nextRetryAt,
    ],
  );

  const id = rows[0].id;
  console.warn(`[dlq] enqueued entry id=${id} transient=${transient} error="${error.message}"`);
  return id;
}

/**
 * Process all DLQ entries that are due for automatic retry.
 *
 * @param {Function} handler  async (rawEvent: object) => void
 * @returns {Promise<{ retried: number, resolved: number, failed: number }>}
 */
export async function processRetries(handler) {
  const { rows } = await db.query(
    `SELECT * FROM dead_letter_queue
     WHERE resolved = FALSE
       AND next_retry_at IS NOT NULL
       AND next_retry_at <= NOW()
       AND retry_count < max_retries
     ORDER BY next_retry_at ASC
     LIMIT 100`,
  );

  let retried = 0;
  let resolved = 0;
  let failed = 0;

  for (const entry of rows) {
    retried++;
    try {
      await handler(entry.raw_event);
      await db.query(`UPDATE dead_letter_queue SET resolved = TRUE, updated_at = NOW() WHERE id = $1`, [entry.id]);
      resolved++;
      console.log(`[dlq] entry id=${entry.id} resolved on retry ${entry.retry_count + 1}`);
    } catch (err) {
      const newCount = entry.retry_count + 1;
      const exhausted = newCount >= entry.max_retries;
      const nextRetry = exhausted ? null : new Date(Date.now() + computeNextRetryDelay(newCount)).toISOString();
      await db.query(
        `UPDATE dead_letter_queue
         SET retry_count = $1, next_retry_at = $2, error_message = $3, updated_at = NOW()
         WHERE id = $4`,
        [newCount, nextRetry, err.message, entry.id],
      );
      failed++;
      console.warn(
        `[dlq] entry id=${entry.id} retry ${newCount} failed: ${err.message}${exhausted ? " (retries exhausted)" : ""}`,
      );
    }
  }

  return { retried, resolved, failed };
}

/**
 * Retrieve DLQ entries for the admin UI.
 *
 * @param {{ page?: number, limit?: number, resolved?: boolean }} opts
 * @returns {Promise<{ data: object[], total: number }>}
 */
export async function getItems({ page = 1, limit = 25, resolved = false } = {}) {
  const offset = (page - 1) * limit;
  const [{ rows }, { rows: countRows }] = await Promise.all([
    db.query(
      `SELECT id, event_id, contract_id, ledger, tx_hash, error_message, error_code,
              retry_count, max_retries, next_retry_at, resolved, created_at, updated_at
       FROM dead_letter_queue
       WHERE resolved = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [resolved, limit, offset],
    ),
    db.query(`SELECT COUNT(*)::INT AS total FROM dead_letter_queue WHERE resolved = $1`, [resolved]),
  ]);
  return { data: rows, total: countRows[0].total };
}

/**
 * Mark a DLQ entry as manually resolved.
 *
 * @param {number} id
 */
export async function resolve(id) {
  await db.query(`UPDATE dead_letter_queue SET resolved = TRUE, updated_at = NOW() WHERE id = $1`, [id]);
  console.log(`[dlq] entry id=${id} manually resolved`);
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
    await db.query(`UPDATE dead_letter_queue SET resolved = TRUE, updated_at = NOW() WHERE id = $1`, [id]);
    console.log(`[dlq] entry id=${id} replayed successfully`);
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
