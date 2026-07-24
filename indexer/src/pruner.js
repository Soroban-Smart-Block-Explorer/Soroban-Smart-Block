/**
 * Automated Data Pruning Task for Temporary Storage Logs
 *
 * Runs on a daily cron schedule. Deletes events whose on-chain storage entry
 * has passed its expiration ledger height, keeping only instance/persistent
 * tier data and active temporary entries.
 *
 * Schedule: daily at 02:00 UTC (configurable via PRUNE_CRON env var).
 * Can also be run once manually: node src/pruner.js --run-now
 */

import "dotenv/config";
import cron from "node-cron";
import { db } from "./db.js";
import config from "./config.js";

const PRUNE_CRON = config.PRUNE_CRON;
const PRUNE_LEDGER_BUFFER = config.PRUNE_LEDGER_BUFFER;

/**
 * Delete events whose storage_tiers contain only "temporary" entries that
 * have expired (ledger < currentLedger - buffer).
 *
 * We use the `ledger` column as a proxy for the entry's creation ledger.
 * Soroban temporary storage has a max TTL of ~110 days (~1,382,400 ledgers at 5s/ledger).
 * We prune entries older than MAX_TEMP_TTL_LEDGERS ledgers.
 */
const MAX_TEMP_TTL_LEDGERS = config.MAX_TEMP_TTL_LEDGERS;

async function getCurrentLedger() {
  const { rows } = await db.query("SELECT COALESCE(MAX(ledger), 0) AS max_ledger FROM events");
  return Number(rows[0].max_ledger);
}

async function pruneExpiredTemporaryData() {
  console.log("[pruner] starting pruning run…");

  const currentLedger = await getCurrentLedger();
  const expiryLedger = currentLedger - MAX_TEMP_TTL_LEDGERS - PRUNE_LEDGER_BUFFER;

  if (expiryLedger <= 0) {
    console.log("[pruner] not enough ledger history yet, skipping");
    return;
  }

  // Delete events that:
  // 1. Are older than the expiry ledger
  // 2. Have storage_tiers that are exclusively temporary (no instance/persistent writes)
  //    OR have no storage_tiers at all (legacy events with no tier info)
  const result = await db.query(
    `
    DELETE FROM events
    WHERE ledger < $1
      AND (
        storage_tiers IS NULL
        OR (
          jsonb_array_length(COALESCE(storage_tiers->'instance',  '[]'::jsonb)) = 0
          AND jsonb_array_length(COALESCE(storage_tiers->'persistent', '[]'::jsonb)) = 0
          AND jsonb_array_length(COALESCE(storage_tiers->'temporary', '[]'::jsonb)) > 0
        )
      )
  `,
    [expiryLedger],
  );

  const deleted = result.rowCount ?? 0;
  console.log(`[pruner] deleted ${deleted} expired temporary-storage events (ledger < ${expiryLedger})`);

  // Also vacuum the table to reclaim space (non-blocking)
  await db.query("VACUUM ANALYZE events").catch(() => {});
  console.log("[pruner] VACUUM ANALYZE complete");

  return deleted;
}

export function startPruner() {
  console.log(`[pruner] scheduled — cron: "${PRUNE_CRON}"`);
  cron.schedule(PRUNE_CRON, () => {
    pruneExpiredTemporaryData().catch((err) => console.error("[pruner] error:", err.message));
  });
}

// Allow manual one-shot run: node src/pruner.js --run-now
if (process.argv.includes("--run-now")) {
  (async () => {
    await db.init();
    await pruneExpiredTemporaryData();
    process.exit(0);
  })().catch((err) => {
    console.error("[pruner] fatal:", err);
    process.exit(1);
  });
}
