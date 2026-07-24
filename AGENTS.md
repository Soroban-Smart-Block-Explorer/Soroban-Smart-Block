# AGENTS.md — Guide for AI Contributors

This file exists for AI coding agents (Claude, Copilot, GPT, etc.) working on this repo. Read it before making any changes.

---

## What this project is

**Soroban Smart Block Explorer** — a block explorer that decodes Soroban smart-contract calls into human-readable form on the Stellar network.

Three components talk to each other:

| Component | Language | Location | What it does |
|-----------|----------|----------|--------------|
| Smart contracts | Rust / Soroban SDK | `contracts/` | On-chain ABI registry (`explorer`) and example ticket contract (`ticket`) |
| Indexer | Node.js | `indexer/` | Polls Soroban RPC, decodes XDR events, writes to Postgres, exposes REST + GraphQL + WebSocket API |
| Frontend | React / TypeScript (Vite) | `frontend/` | Explorer UI — event feed, contract detail, wallet history, sandbox IDE |

Infrastructure: Docker Compose (`docker-compose.yml`) wires Postgres + indexer + frontend together locally.

---

## Navigation

```
contracts/
  explorer/          soroban-explorer-contract (ABI registry, in Cargo workspace)
  ticket/            sample ticket contract (independent crate, used for testing)

indexer/
  src/               Node.js source — api.js is the Express server, index.js is the daemon
  migrations/        SQL migration files (numbered, applied by migrate.js at startup)
  test/              Node.js unit tests (node:test runner)

frontend/
  src/
    pages/           One file per route registered in App.tsx
    components/      Shared React components
    hooks/           Custom React hooks
    services/        API client helpers, WebContainer wrapper, templates
    utils/           Pure utility functions

docs/
  guides/            Markdown source for developer guides
  site/              Pre-built static HTML documentation site
  api/               OpenAPI spec + playground HTML

e2e/
  test/
    api/             HTTP integration tests against a running indexer
    chaos/           Fault-injection scenarios
    load/            k6 load test scripts (spike, soak, baseline)
    playwright/      Browser automation tests
    property/        Property-based tests (fast-check)
    synthetic/       Synthetic event producer for monitoring

.github/workflows/
  ci.yml             Main CI: contract build + tests → indexer tests → frontend check
  deploy.yml         CD: Docker push + deploy (release/* branches and tags only)
  docs.yml           Build and publish GitHub Pages documentation
  e2e-nightly.yml    Nightly: k6 spike/soak, synthetic monitoring
  pr-quality.yml     PR metadata: branch naming, size labels, auto-assign

.husky/
  pre-push           Git hook: runs contract build + tests before every push
```

---

## Architecture rules to preserve

- **`indexer/src/db.js`** is the single database module. Do not create a `db/` subdirectory or split it — a split was attempted before and abandoned.
- **`indexer/src/api.js`** owns all HTTP route definitions. The only exception is `indexer/src/routes/admin.js`, which holds auth-gated admin routes and is imported by `api.js`. Do not add more files to `routes/`.
- Every new page in `frontend/src/pages/` must have a corresponding `<Route>` in [frontend/src/App.tsx](frontend/src/App.tsx).
- SQL changes belong in a new numbered migration file under `indexer/migrations/`, applied automatically by `db.init()` at startup.
- The Cargo workspace (`Cargo.toml` at the root) only includes `contracts/explorer`. The `contracts/ticket` crate is independent and tested separately.

---

## What NOT to push

- `.kiro/`, `update_issues/`, and similar AI-agent scratch directories — they are gitignored and must stay out of commits.
- `docs/IMPLEMENTATION_SUMMARY.md` or `docs/E2E_IMPLEMENTATION_SUMMARY.md` style files — these are AI task logs, not project docs. Do not recreate them.
- Generated `dist/` or `build/` directories — gitignored.
- `.env` files — gitignored; use `.env.example` as the template.
- Orphaned source files — if you add a file, wire it in. Standalone utility modules with no import path are bloat.
- Mock data generators — the `seed-lib.js` pattern (fake Stellar addresses via `Math.random()`) was removed. Do not reintroduce fake data into the source tree.

---

## How to verify task completion

Run these before considering a task done:

### Contracts (required)
```bash
cargo fmt --check
cargo clippy -- -D warnings
cargo build --target wasm32-unknown-unknown --release -p soroban-explorer-contract
cargo test -p soroban-explorer-contract
cd contracts/ticket && cargo test --features testutils --release
```

### Indexer (required if you touched indexer/)
```bash
cd indexer && npm test
```

### Frontend (required if you touched frontend/)
```bash
cd frontend && npm run build   # also runs tsc
```

### Full stack smoke test (optional, needs Docker)
```bash
docker compose up --build -d
curl http://localhost:3001/api/events
```

The pre-push hook (`.husky/pre-push`) runs the contract checks automatically on `git push`. CI (`.github/workflows/ci.yml`) runs all three layers on every PR and push to main.

---

## ABI Format

`register_contract` and `update_contract` both take a `meta: ContractMeta` argument. This is the JSON shape the CLI / SDK invocation must serialize.

### `ContractMeta` struct fields

| Field | Type | Notes |
|---|---|---|
| `version` | `u32` | Schema version for forward compatibility. Set to `1` for the current schema. |
| `abi_version` | `u32` | Ignored on input -- the contract sets this internally (`0` on first registration, incremented on each `update_contract`). Send `0`. |
| `min_ledger` | `u32` | Ignored on input -- set internally to the ledger sequence at write time. Send `0`. |
| `name` | `String` | Human-readable contract name. |
| `description` | `String` | Human-readable contract description. |
| `functions` | `Vec<FunctionAbi>` | List of callable functions (see below). |
| `registered_by` | `Address` | Stellar address of the registering caller. Must match `caller`. |

### `FunctionAbi` struct fields

| Field | Type | Notes |
|---|---|---|
| `name` | `Symbol` | Function name as it appears on-chain (max 32 chars, Soroban `Symbol` rules apply). |
| `description` | `String` | Human-readable description of what the function does. |
| `params` | `Vec<ParamDef>` | Ordered list of parameters (see below). |

### `ParamDef` struct fields

| Field | Type | Notes |
|---|---|---|
| `name` | `Symbol` | Parameter name. |
| `kind` | `Symbol` | Parameter type, e.g. "Address", "i128", "u32", "String", "Bool". |

### Nesting

`ContractMeta.functions` is an array of `FunctionAbi`. Each `FunctionAbi.params` is an array of `ParamDef`. There is no further nesting:

```
ContractMeta
|-- functions: [FunctionAbi, FunctionAbi, ...]
    |-- params: [ParamDef, ParamDef, ...]
```

### Example: registering a simple SEP-41 token contract

```json
{
  "caller": "GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234",
  "contract_id": "ba5eba11f00dca7f00dca7f00dca7f00dca7f00dca7f00dca7f00dca7f00dca",
  "meta": {
    "version": 1,
    "abi_version": 0,
    "min_ledger": 0,
    "name": "ExampleToken",
    "description": "A SEP-41 compliant fungible token contract.",
    "registered_by": "GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234",
    "functions": [
      {
        "name": "transfer",
        "description": "Transfers an amount of tokens from one address to another.",
        "params": [
          { "name": "from", "kind": "Address" },
          { "name": "to", "kind": "Address" },
          { "name": "amount", "kind": "i128" }
        ]
      },
      {
        "name": "balance",
        "description": "Returns the token balance of the given address.",
        "params": [
          { "name": "id", "kind": "Address" }
        ]
      },
      {
        "name": "mint",
        "description": "Mints new tokens to the given address. Admin only.",
        "params": [
          { "name": "to", "kind": "Address" },
          { "name": "amount", "kind": "i128" }
        ]
      }
    ]
  }
}
```

Note: `abi_version` and `min_ledger` are accepted in the payload for schema completeness but are always overwritten by the contract on `register_contract` -- send `0` for both.

## Common pitfalls

| Mistake | Consequence | Correct approach |
|---------|-------------|------------------|
| Writing bare English sentences in JS without `//` | Syntax error — file won't parse | Always prefix comment text with `//` |
| Adding a new component but not importing it from a page | Dead code — it will be deleted in the next cleanup | Import it or don't create it |
| Importing from a module that was deleted | Tests fail at import time | Check `indexer/src/` before writing import statements |
| Creating a parallel DB layer or route layer | Causes confusion in the next cleanup | Extend `db.js` and `api.js` directly |
| Bumping `soroban-sdk` version in one contract but not the other | Version mismatch linker errors | Keep both contracts on the same SDK version |
