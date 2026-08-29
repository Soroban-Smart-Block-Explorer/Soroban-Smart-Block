# ADR-007: Defer range-partitioning the `events` table

- **Title:** Keep `events` a single (unpartitioned) table for now; revisit at a defined growth threshold
- **Status:** Accepted
- **Context:** `api_audit_log` (see [`005_api_auth_rate_limiting.sql`](../../indexer/migrations/005_api_auth_rate_limiting.sql)) is monthly range-partitioned by `timestamp` because it is a retention-bounded log: old partitions are dropped wholesale, and almost every query is time-window-scoped. `events` (see [`002_core_schema.sql`](../../indexer/migrations/002_core_schema.sql)) is different — it's the permanent, queryable history of on-chain activity (no retention/deletion), and its two hot access patterns — "recent events" and "per-contract history" — are already served by targeted B-tree indexes rather than full-table or full-partition scans:
  - `idx_events_seq_desc_contract_id` ([`020_keyset_index.sql`](../../indexer/migrations/020_keyset_index.sql)) — keyset pagination on `seq DESC`.
  - `idx_events_contract_created` ([`028_contract_events_daily_index.sql`](../../indexer/migrations/028_contract_events_daily_index.sql)) — `(contract_id, created_at)` range scans for per-contract stats.
  - `idx_events_contract_caller` ([`022_caller_index.sql`](../../indexer/migrations/022_caller_index.sql)) — `(contract_id, caller_address)`.

  [`scripts/benchmark-events-partitioning.js`](../../scripts/benchmark-events-partitioning.js) runs `EXPLAIN (ANALYZE, BUFFERS)` for both hot queries and can seed synthetic rows (`--seed=N`) to check plan/cost at a chosen row count. At the table's current size, both queries already resolve via the indexes above (`Index Scan`/`Index Only Scan`, not `Seq Scan`) with sub-10ms execution time — a B-tree index scan is O(log n), so this holds well past current volumes; partitioning would prune scans by *partition* rather than index depth, which mainly pays off once a single partition's *working set* stops fitting in shared_buffers, or once bulk deletes/retention become a requirement (neither is true today: `events` has no retention policy).
- **Decision:** Do not partition `events` now. Revisit if either becomes true:
  1. `events` row count exceeds **~50M rows** (run `scripts/benchmark-events-partitioning.js --seed=50000000` against a scratch DB to confirm the hot-query plans are still index scans, not seq scans, before deferring further), or
  2. p95 latency for `GET /api/events` or `GET /api/contracts/:id/stats` regresses past its target (50ms / 90ms respectively) in production metrics, whichever comes first.

  If partitioning becomes necessary, prefer `ledger`-range partitions (per the issue) sized so each partition covers a bounded, roughly equal row count (e.g. per N million ledgers) rather than fixed calendar buckets, since ledger production rate — not wall-clock time — is what drives `events` growth.
- **Consequences:** No migration work now; the existing indexes keep both hot paths fast. The cost is that `events` will eventually need re-evaluation as it grows unbounded (no retention), and the threshold above is an estimate — it should be confirmed against real row-count/latency metrics as the table approaches it, not treated as exact.
- **Rejected alternatives:**
  - Partition now by `ledger` range: adds migration and query-routing complexity (every query must include a partition-pruning predicate to benefit) for no measured benefit at current scale — the existing B-tree indexes already keep both hot queries fast.
  - Partition by `created_at` (mirroring `api_audit_log`): `events` has no retention policy, so the main benefit of time-partitioning (cheap bulk-drop of old partitions) doesn't apply here.
