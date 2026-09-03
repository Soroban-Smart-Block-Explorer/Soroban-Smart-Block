import { logger } from "./logger.js";
/**
 * Circuit Breaker Indexer
 * Monitors contract events for pause/unpause operations and updates circuit breaker status.
 */

import { db } from "./db.js";
import { hasCircuitBreaker, determinePauseStatus } from "./circuitBreakerDetector.js";

/**
 * Process a decoded event and update circuit breaker status if applicable.
 *
 * @param {object} decoded - Decoded event from decoder.js
 * @param {object} meta - Contract metadata
 */
export async function processCircuitBreakerEvent(decoded, meta) {
  if (!meta) return;

  // Check if contract has circuit breaker mechanism
  if (!hasCircuitBreaker(meta)) return;

  const fnName = decoded.function.toLowerCase();

  // Check if this is a pause/unpause event
  if (fnName.includes("pause") || fnName.includes("unpause") || fnName.includes("resume")) {
    const isPaused = fnName.includes("pause") && !fnName.includes("unpause");

    // Update circuit breaker status in database
    await db
      .updateCircuitBreakerStatus(decoded.contract_id, isPaused, decoded.ledger, decoded.tx_hash ?? null)
      .catch((err) => logger.error("[circuitBreakerIndexer] Failed to update status:", err.message));
  }
}

/**
 * Scan contract events and determine current pause status.
 * Called during contract registration or periodic refresh.
 *
 * @param {string} contractId - Contract ID
 * @param {object} meta - Contract metadata
 */
export async function refreshCircuitBreakerStatus(contractId, meta) {
  if (!meta || !hasCircuitBreaker(meta)) return;

  try {
    // Fetch recent events for this contract
    const events = await db.getContractTransactions(contractId, {
      limit: 1000,
    });

    if (!events.data || events.data.length === 0) {
      // No events yet, assume operational
      await db.updateCircuitBreakerStatus(contractId, false, null);
      return;
    }

    // Determine pause status from events
    const status = determinePauseStatus(events.data);

    // Update database
    await db.updateCircuitBreakerStatus(contractId, status.isPaused, status.lastStatusChange, status.txHash ?? null);
  } catch (err) {
    logger.error("[circuitBreakerIndexer] Failed to refresh status:", err.message);
  }
}
