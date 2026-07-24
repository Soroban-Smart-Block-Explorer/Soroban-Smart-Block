# Optional / Experimental Modules

These modules are **not wired into the running indexer**. They are complete, tested implementations of features that require additional infrastructure or deliberate opt-in configuration.

| File | What it does | Requires |
|---|---|---|
| `kafkaEventBus.js` | Redis-backed event bus with Kafka-like at-least-once delivery and 7-day retention | `REDIS_URL` env var; swap to `kafkajs` for true Kafka |
| `leaderElection.js` | Redis `SET NX EX` distributed leader election for multi-instance deployments | `REDIS_URL`; set `LEADER_ELECTION_KEY` |
| `rpcProviderPool.js` | Weighted RPC provider pool with sliding-window health scoring and automatic failover | Multiple `SOROBAN_RPC_URLS` configured |
| `rpcPool.js` | Simpler round-robin RPC pool (axios-based, CommonJS) | `axios` package |
| `eventInserter.js` | Batch event inserter with per-event error tracking (CommonJS, simplified schema) | None — but targets an older schema subset |

## How to enable

Each module exports a self-contained API. To activate one, import it from `../index.js` or whichever module is appropriate, and follow the configuration instructions in its file header.

For `kafkaEventBus` and `leaderElection`, ensure `REDIS_URL` is set in your `.env` before starting the indexer.
