/**
 * Concurrent-write integration test (#587).
 *
 * Requires a running PostgreSQL instance. Set TEST_DATABASE_URL in env,
 * or falls back to DATABASE_URL. If neither is set the test is skipped.
 *
 * Usage (CI): TEST_DATABASE_URL=postgres://... node --test test/concurrentWrite.test.js
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { runMigrations } from "../src/migrate.js";

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

if (!DB_URL) {
  console.warn("[concurrentWrite.test] No TEST_DATABASE_URL set — skipping integration tests.");
  process.exit(0);
}

// db.js opens its own pool against process.env.DATABASE_URL at import time,
// so it must be set before the module is loaded.
process.env.DATABASE_URL = DB_URL;
const { db } = await import("../src/db.js");

const silentLogger = { warn() {}, error() {} };

describe("Concurrent event upserts (#587)", () => {
  let pool;

  before(async () => {
    pool = new pg.Pool({ connectionString: DB_URL, max: 5 });
    await runMigrations(pool);
  });

  after(async () => {
    await pool.end();
  });

  it("10 concurrent identical upsertEventValidated calls produce exactly 1 row", async () => {
    const contractId = `TEST_CONCURRENT_${Date.now()}`;
    const ledger = 123456;
    const txHash = `tx_${Date.now()}`;

    const buildEvent = () => ({
      contract_id: contractId,
      function: "transfer",
      ledger,
      tx_hash: txHash,
      description: "concurrent upsert test event",
      raw_topics: ["transfer"],
      raw_data: "{}",
    });

    try {
      await Promise.all(Array.from({ length: 10 }, () => db.upsertEventValidated(buildEvent(), silentLogger)));

      const { rows } = await pool.query(
        "SELECT seq FROM events WHERE contract_id = $1 AND ledger = $2 AND tx_hash = $3",
        [contractId, ledger, txHash],
      );
      assert.equal(rows.length, 1, `expected exactly 1 row, got ${rows.length}`);
    } finally {
      await pool.query("DELETE FROM events WHERE contract_id = $1", [contractId]);
    }
  });
});
