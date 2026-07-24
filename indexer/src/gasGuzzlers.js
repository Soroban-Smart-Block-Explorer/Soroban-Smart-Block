/**
 * Daily Gas Consumption Leaderboard
 *
 * Background worker that aggregates cpu_instructions and fee_charged
 * over 24-hour windows, bucketed by contract_id, to produce a ranked
 * leaderboard of the top 10 most resource-heavy contracts.
 *
 * Results are cached in-memory and refreshed every REFRESH_INTERVAL_MS.
 * The API layer reads from this cache to serve /api/v1/analytics/gas-guzzlers.
 */

import { db } from "./db.js";
import config from "./config.js";

const REFRESH_INTERVAL_MS = config.GAS_GUZZLERS_INTERVAL_MS;
const TOP_N = 10;

/** @type {GasGuzzlerEntry[]} */
let _cache = [];
let _lastUpdated = null;

/**
 * @typedef {Object} GasGuzzlerEntry
 * @property {string}  contract_id
 * @property {string}  total_cpu_instructions
 * @property {string}  total_fee_charged
 * @property {number}  tx_count
 * @property {string}  window_start  ISO timestamp
 */

/**
 * Query the DB and refresh the in-memory leaderboard cache.
 */
async function refresh() {
  try {
    const { rows } = await db.query(
      `SELECT
         contract_id,
         SUM(cpu_instructions)::TEXT  AS total_cpu_instructions,
         SUM(fee_charged)::TEXT       AS total_fee_charged,
         COUNT(*)::INT                AS tx_count,
         DATE_TRUNC('day', NOW())::TEXT AS window_start
       FROM events
       WHERE created_at >= NOW() - INTERVAL '24 hours'
         AND contract_id IS NOT NULL
         AND contract_id <> ''
       GROUP BY contract_id
       ORDER BY SUM(cpu_instructions) DESC NULLS LAST
       LIMIT $1`,
      [TOP_N],
    );
    _cache = rows;
    _lastUpdated = new Date().toISOString();
    console.log(`[gasGuzzlers] leaderboard refreshed — ${rows.length} contracts ranked`);
  } catch (err) {
    console.error("[gasGuzzlers] refresh failed:", err.message);
  }
}

/**
 * Start the background refresh loop.
 */
export function startGasGuzzlersWorker() {
  refresh(); // immediate first run
  setInterval(refresh, REFRESH_INTERVAL_MS);
}

/**
 * Return the current cached leaderboard.
 * @returns {{ data: GasGuzzlerEntry[], last_updated: string|null }}
 */
export function getGasGuzzlers() {
  return { data: _cache, last_updated: _lastUpdated };
}
