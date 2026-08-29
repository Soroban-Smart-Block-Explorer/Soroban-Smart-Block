#!/usr/bin/env node
// Closes #750 — reproducible benchmark backing ADR-007's partitioning
// decision. Measures the two range-scoped access patterns the `events`
// table needs to stay fast (recent events, per-contract history) at a
// given row count, using the indexes from migrations 020/022/028.
//
// Usage:
//   DATABASE_URL=postgres://... node scripts/benchmark-events-partitioning.js [--seed=5000000]
//
// Without --seed, it benchmarks against whatever data is already present.
// With --seed=N, it tops up the table with synthetic rows (batched inserts)
// until it holds at least N rows before benchmarking.

import pg from "pg";

const { Pool } = pg;

function parseSeedArg() {
  const arg = process.argv.find((a) => a.startsWith("--seed="));
  return arg ? Number(arg.split("=")[1]) : null;
}

async function seedTo(pool, targetRows) {
  const { rows } = await pool.query("SELECT COUNT(*)::bigint AS n FROM events");
  const current = Number(rows[0].n);
  if (current >= targetRows) {
    console.log(`events already has ${current} rows (>= target ${targetRows}), skipping seed`);
    return;
  }
  const toInsert = targetRows - current;
  const batchSize = 10_000;
  console.log(`seeding ${toInsert} synthetic rows in batches of ${batchSize}...`);
  for (let inserted = 0; inserted < toInsert; inserted += batchSize) {
    const n = Math.min(batchSize, toInsert - inserted);
    await pool.query(
      `INSERT INTO events (contract_id, function, ledger, description, created_at)
       SELECT
         'CONTRACT' || (floor(random() * 500))::text,
         'fn_' || (floor(random() * 20))::text,
         1000000 + gs,
         'synthetic benchmark event',
         NOW() - (random() * interval '365 days')
       FROM generate_series(1, $1) AS gs`,
      [n],
    );
  }
  console.log("seed complete");
}

async function explain(pool, label, sql, params) {
  const { rows } = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
  const plan = rows[0]["QUERY PLAN"][0];
  console.log(`\n--- ${label} ---`);
  console.log(`planning time: ${plan["Planning Time"]}ms, execution time: ${plan["Execution Time"]}ms`);
  console.log(`top node: ${plan.Plan["Node Type"]}${plan.Plan["Index Name"] ? ` (${plan.Plan["Index Name"]})` : ""}`);
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL || process.env.TEST_DATABASE_URL });
  const seedTarget = parseSeedArg();
  if (seedTarget) await seedTo(pool, seedTarget);

  await explain(
    pool,
    "recent events (keyset, no filter)",
    "SELECT * FROM events ORDER BY seq DESC LIMIT 50",
    [],
  );

  await explain(
    pool,
    "per-contract history (90-day range)",
    "SELECT * FROM events WHERE contract_id = $1 AND created_at > NOW() - interval '90 days' ORDER BY created_at DESC LIMIT 50",
    ["CONTRACT1"],
  );

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
