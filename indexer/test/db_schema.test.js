/**
 * Real DB integration test.
 *
 * Requires a running PostgreSQL instance. Set TEST_DATABASE_URL in env,
 * or falls back to DATABASE_URL. If neither is set the test is skipped.
 *
 * Usage (CI): TEST_DATABASE_URL=postgres://... node --test test/db_schema.test.js
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { runMigrations } from "../src/migrate.js";

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

if (!DB_URL) {
  console.warn("[db_schema.test] No TEST_DATABASE_URL set — skipping integration tests.");
  process.exit(0);
}

describe("DB schema integration", () => {
  let pool;

  before(async () => {
    pool = new pg.Pool({ connectionString: DB_URL, max: 3 });
    // Run migrations against the real DB
    await runMigrations(pool);
  });

  after(async () => {
    await pool.end();
  });

  it("schema_migrations table exists and has entries", async () => {
    const { rows } = await pool.query("SELECT version FROM schema_migrations ORDER BY version");
    assert.ok(rows.length > 0, "No migrations recorded");
    // All migration files should be present
    assert.ok(rows.some((r) => r.version.includes("002_core_schema")));
    assert.ok(rows.some((r) => r.version.includes("003_invocations")));
    assert.ok(rows.some((r) => r.version.includes("004_vaults")));
  });

  it("events table has expected columns", async () => {
    const { rows } = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'events'
    `);
    const cols = new Set(rows.map((r) => r.column_name));
    for (const col of ["seq", "contract_id", "function", "ledger", "description",
                        "cpu_instructions", "is_clawback", "zk_host_calls"]) {
      assert.ok(cols.has(col), `Missing column: ${col}`);
    }
  });

  it("contracts table has expected columns", async () => {
    const { rows } = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'contracts'
    `);
    const cols = new Set(rows.map((r) => r.column_name));
    for (const col of ["id", "name", "source_files", "has_circuit_breaker", "is_rwa"]) {
      assert.ok(cols.has(col), `Missing column: ${col}`);
    }
  });

  it("indexes exist on events", async () => {
    const { rows } = await pool.query(`
      SELECT indexname FROM pg_indexes WHERE tablename = 'events'
    `);
    const idxs = new Set(rows.map((r) => r.indexname));
    for (const idx of ["idx_events_contract", "idx_events_ledger",
                        "idx_events_contract_ledger", "idx_events_search_fts"]) {
      assert.ok(idxs.has(idx), `Missing index: ${idx}`);
    }
  });

  it("dead_letter_queue table exists with expected columns", async () => {
    const { rows } = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'dead_letter_queue'
    `);
    const cols = new Set(rows.map((r) => r.column_name));
    for (const col of ["id", "event_id", "contract_id", "ledger", "tx_hash",
                        "raw_event", "error_message", "error_code", "retry_count",
                        "max_retries", "next_retry_at", "resolved", "created_at", "updated_at"]) {
      assert.ok(cols.has(col), `Missing column: ${col}`);
    }
  });

  it("dead_letter_queue indexes exist", async () => {
    const { rows } = await pool.query(`
      SELECT indexname FROM pg_indexes WHERE tablename = 'dead_letter_queue'
    `);
    const idxs = new Set(rows.map((r) => r.indexname));
    for (const idx of ["idx_dlq_resolved", "idx_dlq_next_retry", "idx_dlq_ledger"]) {
      assert.ok(idxs.has(idx), `Missing DLQ index: ${idx}`);
    }
  });

  it("upsert and query events round-trips correctly", async () => {
    const testContractId = `TEST_${Date.now()}`;
    await pool.query(`
      INSERT INTO events (contract_id, function, ledger, description)
      VALUES ($1, 'transfer', 9999999, 'integration test event')
    `, [testContractId]);

    const { rows } = await pool.query(
      "SELECT * FROM events WHERE contract_id = $1", [testContractId]
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].function, "transfer");
    assert.equal(rows[0].ledger, 9999999);

    // Cleanup
    await pool.query("DELETE FROM events WHERE contract_id = $1", [testContractId]);
  });

  it("runMigrations is idempotent (second run applies nothing)", async () => {
    const ran = await runMigrations(pool);
    assert.equal(ran, 0, "Second run should apply 0 migrations");
  });
});
