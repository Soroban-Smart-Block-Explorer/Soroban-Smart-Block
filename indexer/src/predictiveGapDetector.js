/**
 * Issue #209 — Predictive Gap Detector
 *
 * Extends reactive gap detection (gapDetector.js) with predictive intelligence:
 * tracks ledger arrival times, flags ledgers that are overdue before they appear
 * as gaps in the DB, and calculates estimated catch-up time.
 *
 * Key capabilities:
 *   - Rolling average inter-ledger arrival time tracking
 *   - Overdue detection when next ledger is > 2× avg interval late
 *   - Gap detection for sequences exceeding GAP_THRESHOLD (default: 3 ledgers)
 *   - Catch-up time estimation based on historical indexing rate
 *   - Stateless analysis function for use in periodic monitoring loops
 */

import config from "./config.js";

const GAP_THRESHOLD = config.PREDICTIVE_GAP_THRESHOLD;
const HISTORY_SIZE = config.PREDICTIVE_HISTORY_SIZE;

let _history = [];
let _lastLedger = 0;
let _lastLedgerAt = 0;

/**
 * Record that a ledger was successfully indexed.
 * Updates the rolling history used for average interval calculation.
 *
 * @param {number} ledger
 */
export function recordLedger(ledger) {
  const now = Date.now();
  if (ledger > _lastLedger) {
    _history.push({ ledger, arrivedAt: now });
    if (_history.length > HISTORY_SIZE) _history.shift();
    _lastLedger = ledger;
    _lastLedgerAt = now;
  }
}

/**
 * Compute the average inter-ledger interval from the rolling history.
 *
 * @returns {number | null}  milliseconds, or null if fewer than 2 data points
 */
export function avgInterLedgerMs() {
  if (_history.length < 2) return null;
  let sum = 0;
  for (let i = 1; i < _history.length; i++) {
    sum += _history[i].arrivedAt - _history[i - 1].arrivedAt;
  }
  return sum / (_history.length - 1);
}

/**
 * Check whether the next expected ledger is overdue (> 2× average interval).
 *
 * @returns {{ overdue: boolean, expectedLedger: number, overdueByMs: number } | null}
 *   null if there is not yet enough history to predict
 */
export function checkOverdue() {
  const avg = avgInterLedgerMs();
  if (!avg || !_lastLedgerAt) return null;

  const expectedAt = _lastLedgerAt + avg;
  const overdueByMs = Math.max(0, Date.now() - expectedAt);
  const overdue = overdueByMs > avg;

  return {
    overdue,
    expectedLedger: _lastLedger + 1,
    overdueByMs,
  };
}

/**
 * Detect gaps in a sorted array of observed ledger numbers.
 * Only gaps of at least GAP_THRESHOLD ledgers are returned.
 *
 * @param {number[]} ledgers  Sorted ascending array of ledger numbers
 * @returns {{ from: number, to: number, size: number }[]}
 */
export function detectGaps(ledgers) {
  if (ledgers.length < 2) return [];
  const gaps = [];
  for (let i = 1; i < ledgers.length; i++) {
    const diff = ledgers[i] - ledgers[i - 1];
    if (diff > 1) {
      const size = diff - 1;
      if (size >= GAP_THRESHOLD) {
        gaps.push({ from: ledgers[i - 1] + 1, to: ledgers[i] - 1, size });
      }
    }
  }
  return gaps;
}

/**
 * Estimate the time required to catch up on a ledger gap.
 *
 * @param {number}        gapSize  Number of missing ledgers
 * @param {number | null} [avgMs]  Average interval override; uses rolling avg if omitted
 * @returns {{ estimatedMs: number, estimatedSec: number } | null}
 */
export function estimateCatchupTime(gapSize, avgMs) {
  const interval = avgMs ?? avgInterLedgerMs();
  if (!interval) return null;
  const estimatedMs = gapSize * interval;
  return { estimatedMs, estimatedSec: estimatedMs / 1000 };
}

/**
 * Full predictive analysis: combines overdue check, gap detection, and catch-up estimation.
 *
 * @param {number[]} recentLedgers  Sorted list of recently indexed ledger numbers
 * @returns {{
 *   overdue:    boolean,
 *   prediction: { overdue: boolean, expectedLedger: number, overdueByMs: number } | null,
 *   gaps:       { from: number, to: number, size: number }[],
 *   catchup:    { estimatedMs: number, estimatedSec: number } | null
 * }}
 */
export function analyze(recentLedgers) {
  const prediction = checkOverdue();
  const gaps = detectGaps(recentLedgers);
  const largestGap = gaps.reduce((m, g) => (g.size > (m?.size ?? 0) ? g : m), null);
  const catchup = largestGap ? estimateCatchupTime(largestGap.size) : null;

  return {
    overdue: prediction?.overdue ?? false,
    prediction,
    gaps,
    catchup,
  };
}

/** Reset internal rolling state. Intended for use in tests. */
export function _reset() {
  _history = [];
  _lastLedger = 0;
  _lastLedgerAt = 0;
}
