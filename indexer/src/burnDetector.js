import { logger } from "./logger.js";
/**
 * burnDetector.js
 *
 * Scans recent burn events and flags contracts where an unusual percentage of
 * total supply was destroyed within a single ledger block.
 *
 * Heuristic:
 *   - Collect all burn events in the last WINDOW_LEDGERS ledgers.
 *   - Group by contract_id + ledger.
 *   - Sum burned amounts per group.
 *   - If the total burned in one ledger exceeds BURN_THRESHOLD_PCT % of the
 *     running total supply estimate (sum of all mints minus all burns), flag it.
 *
 * Results are stored in-memory and exposed via getBurnAlerts().
 */

import { db } from "./db.js";

const WINDOW_LEDGERS = 100; // look-back window
const BURN_THRESHOLD_PCT = 10; // flag if ≥10 % of estimated supply burned in one ledger
const POLL_INTERVAL_MS = 30_000;

/** @type {Map<string, { contractId: string, ledger: number, burnedPct: number, burnedAmount: bigint, flaggedAt: number }[]>} */
const alerts = new Map();

/**
 * Run one detection pass over recent events.
 */
export async function runBurnDetection() {
  try {
    const maxLedger = await db.getMaxLedger();
    if (!maxLedger) return;

    const minLedger = maxLedger - WINDOW_LEDGERS;

    // Fetch burn and mint events in the window
    const { rows: burnRows } = await db.query(
      `SELECT contract_id, ledger, raw_data
       FROM events
       WHERE function = 'burn' AND ledger >= $1`,
      [minLedger],
    );

    const { rows: mintRows } = await db.query(
      `SELECT contract_id, SUM((raw_data::jsonb->>'amount')::NUMERIC)::TEXT AS total_minted
       FROM events
       WHERE function IN ('mint') AND ledger >= $1
       GROUP BY contract_id`,
      [minLedger],
    );

    // Build supply estimate per contract (minted - burned so far)
    const mintedByContract = new Map();
    for (const r of mintRows) {
      mintedByContract.set(r.contract_id, BigInt(r.total_minted?.split(".")[0] ?? "0"));
    }

    // Group burns by contract + ledger
    const burnsByLedger = new Map(); // key: `${contractId}:${ledger}`
    for (const r of burnRows) {
      let amount = 0n;
      try {
        const parsed = JSON.parse(r.raw_data ?? "{}");
        amount = BigInt(String(parsed?.amount ?? parsed ?? "0").split(".")[0]);
      } catch {
        /* skip unparseable */
      }

      const key = `${r.contract_id}:${r.ledger}`;
      burnsByLedger.set(key, {
        contractId: r.contract_id,
        ledger: Number(r.ledger),
        total: (burnsByLedger.get(key)?.total ?? 0n) + amount,
      });
    }

    // Evaluate each group against the threshold
    const newAlerts = new Map();
    for (const { contractId, ledger, total } of burnsByLedger.values()) {
      const supply = mintedByContract.get(contractId) ?? total; // fallback: treat burned as 100%
      if (supply === 0n) continue;

      const pct = Number((total * 10000n) / supply) / 100; // two decimal places
      if (pct >= BURN_THRESHOLD_PCT) {
        if (!newAlerts.has(contractId)) newAlerts.set(contractId, []);
        newAlerts.get(contractId).push({
          contractId,
          ledger,
          burnedPct: pct,
          burnedAmount: total,
          flaggedAt: Date.now(),
        });
      }
    }

    // Merge into global alerts map
    for (const [contractId, items] of newAlerts) {
      alerts.set(contractId, items);
    }
    // Clear contracts that no longer have alerts
    for (const contractId of alerts.keys()) {
      if (!newAlerts.has(contractId)) alerts.delete(contractId);
    }
  } catch (err) {
    logger.error("[burnDetector] error:", err.message);
  }
}

/**
 * Return current burn alerts, optionally filtered by contractId.
 * @param {string} [contractId]
 * @returns {Array<{ contractId: string, ledger: number, burnedPct: number, burnedAmount: string, flaggedAt: number }>}
 */
export function getBurnAlerts(contractId) {
  if (contractId) {
    return (alerts.get(contractId) ?? []).map((a) => ({
      ...a,
      burnedAmount: a.burnedAmount.toString(),
    }));
  }
  return [...alerts.values()].flat().map((a) => ({
    ...a,
    burnedAmount: a.burnedAmount.toString(),
  }));
}

/**
 * Start the polling loop.
 */
export function startBurnDetector() {
  runBurnDetection();
  setInterval(runBurnDetection, POLL_INTERVAL_MS);
  logger.info("[burnDetector] started, polling every", POLL_INTERVAL_MS / 1000, "s");
}
