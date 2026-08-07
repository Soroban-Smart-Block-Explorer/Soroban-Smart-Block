/**
 * Circuit Breaker Detector
 * Detects whether a contract implements a pausable mechanism and tracks its status.
 * Looks for common pause-related state variables and events.
 */

/**
 * Detect if a contract likely has a circuit breaker (pausable) mechanism.
 * Checks for common pause-related patterns in function names and event topics.
 *
 * @param {object} meta - Contract metadata with functions array
 * @returns {boolean} - True if contract appears to have pause mechanism
 */
export function hasCircuitBreaker(meta) {
  if (!meta || !meta.functions) return false;

  const pauseKeywords = ["pause", "unpause", "is_paused", "paused", "emergency", "halt", "stop"];
  const fnNames = meta.functions.map((f) => f.name.toLowerCase());

  return pauseKeywords.some((keyword) => fnNames.some((fn) => fn.includes(keyword)));
}

/**
 * Determine the pause status based on recent events.
 * Looks for pause/unpause events to determine current state.
 *
 * @param {array} events - Array of decoded events for the contract
 * @returns {object} - { isPaused: boolean, lastStatusChange: number|null, txHash?: string|null, reason?: string }
 */
export function determinePauseStatus(events) {
  if (!events || events.length === 0) {
    return { isPaused: false, lastStatusChange: null, txHash: null };
  }

  // Sort events by ledger descending to find most recent status change
  const sorted = [...events].sort((a, b) => b.ledger - a.ledger);

  for (const event of sorted) {
    const fn = event.function.toLowerCase();

    if (fn.includes("pause") && !fn.includes("unpause")) {
      return {
        isPaused: true,
        lastStatusChange: event.ledger,
        txHash: event.tx_hash ?? null,
        reason: event.description,
      };
    }

    if (fn.includes("unpause") || (fn.includes("resume") && !fn.includes("pause"))) {
      return {
        isPaused: false,
        lastStatusChange: event.ledger,
        txHash: event.tx_hash ?? null,
        reason: event.description,
      };
    }
  }

  return { isPaused: false, lastStatusChange: null, txHash: null };
}

/**
 * Generate a status banner for display in the UI.
 *
 * @param {object} status - Result from determinePauseStatus
 * @returns {object} - { text: string, color: string, icon: string }
 */
export function getStatusBanner(status) {
  if (status.isPaused) {
    return {
      text: "Status: Paused by Emergency Administration",
      color: "#ef4444",
      icon: "⛔",
      severity: "critical",
    };
  }

  return {
    text: "Status: Operational",
    color: "#22c55e",
    icon: "✓",
    severity: "ok",
  };
}
