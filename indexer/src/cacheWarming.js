/**
 * Cache Warming — pre-populate Redis with hot data on deploy.
 *
 * Strategy:
 * 1. Warm events list pages 1–3 (highest traffic)
 * 2. Warm the 10 most active contracts (by event count)
 *
 * Called once from index.js after db.init().  Failures are non-fatal.
 */

import { cacheSet } from "./cacheLayer.js";
import { db } from "./db.js";

export async function warmCache() {
  console.log("[cache:warm] starting...");
  const results = { warmed: 0, failed: 0 };

  // Warm the first 3 keyset pages of the events list (cursor chain, #490).
  // Keys mirror the /api/events cache key: events:list:{contract}:{fn}:{after}:{limit}:{type}
  let after = 0;
  for (let page = 1; page <= 3; page++) {
    try {
      const result = await db.getEventsCursor({ after_seq: after, limit: 25 });
      const key = `events:list:::${after}:25:`;
      await cacheSet(key, result, "events_list", 0);
      results.warmed++;
      if (result.next_cursor === null) break;
      after = result.next_cursor;
    } catch (e) {
      console.warn(`[cache:warm] events page ${page} failed:`, e.message);
      results.failed++;
      break;
    }
  }

  // Warm top 10 most active contracts
  try {
    const top = await db.getTopContracts(10);
    for (const { contract_id } of top) {
      try {
        const meta = await db.getContractMeta(contract_id);
        if (meta) {
          await cacheSet(`contracts:single:${contract_id}`, meta, "contracts_single", 0);
          results.warmed++;
        }
      } catch {
        /* individual contract warm failure is non-fatal */
      }
    }
  } catch (e) {
    console.warn("[cache:warm] top contracts failed:", e.message);
    results.failed++;
  }

  console.log(`[cache:warm] complete — warmed ${results.warmed}, failed ${results.failed}`);
}
