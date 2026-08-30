# ⬡ Soroban Smart Block Explorer

> **Human-readable Soroban contract events on Stellar.**
> Instead of raw XDR bytes, users see: _"Address GABC… swapped 100 USDC → 98.7 XLM on StellarSwap at ledger #4521983."_

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Built on Stellar](https://img.shields.io/badge/Built%20on-Stellar-blueviolet)](https://stellar.org)
[![CI](https://github.com/Soroban-Smart-Block-Explorer/Soroban-Smart-Block/actions/workflows/ci.yml/badge.svg)](https://github.com/Soroban-Smart-Block-Explorer/Soroban-Smart-Block/actions/workflows/ci.yml)
[![CodeQL](https://github.com/Soroban-Smart-Block-Explorer/Soroban-Smart-Block/actions/workflows/security.yml/badge.svg)](https://github.com/Soroban-Smart-Block-Explorer/Soroban-Smart-Block/actions/workflows/security.yml)
[![codecov](https://codecov.io/gh/Soroban-Smart-Block-Explorer/Soroban-Smart-Block/branch/main/graph/badge.svg)](https://codecov.io/gh/Soroban-Smart-Block-Explorer/Soroban-Smart-Block)

---

## The Problem

Stellar block explorers have excellent support for classic assets but poor support for Soroban smart contracts. When a user calls `swap` on a DEX, explorers show raw XDR bytes — unreadable to anyone. This "black box" experience dampens DeFi, NFT, and web3 growth on Stellar.

## The Solution

Soroban Smart Block Explorer decodes contract calls on the fly using an ABI-like metadata registry, turning opaque XDR into plain English.

| Before                      | After                                                                         |
| --------------------------- | ----------------------------------------------------------------------------- |
| `AAAAA9hZ...[Raw XDR]...==` | Address `GABC…` swapped 100 USDC → 98.7 XLM on StellarSwap at ledger #4521983 |

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Soroban RPC / Horizon                                  │
│  (getEvents, getTransaction)                            │
└────────────────────┬────────────────────────────────────┘
                     │ poll every 5 s
┌────────────────────▼────────────────────────────────────┐
│  Indexer  (Node.js)                                     │
│  • Fetches raw events via SorobanRpc.getEvents()        │
│  • Decodes XDR → human text using ABI registry          │
│  • Stores decoded events in PostgreSQL                  │
│  • Exposes REST API on :3001                            │
└────────────────────┬────────────────────────────────────┘
                     │ REST /api/*
┌────────────────────▼────────────────────────────────────┐
│  React Frontend  (Vite + TanStack Query)                │
│  • Home: paginated event feed + function filter         │
│  • /contract/:id — ABI metadata + event history        │
│  • /wallet/:address — wallet transaction history        │
│  • /event/:seq — full decoded event detail              │
└─────────────────────────────────────────────────────────┘
                     ▲
┌────────────────────┴────────────────────────────────────┐
│  Soroban Contract  (Rust)                               │
│  • ContractRegistry — stores ABI-like metadata          │
│  • EventDecoder — persists decoded events on-chain      │
└─────────────────────────────────────────────────────────┘
```

---

### Architecture Decision Records

- [ADR index](docs/adr/README.md) for the six core design choices behind the explorer.

## Quick Start

### Prerequisites

- Rust + `wasm32-unknown-unknown` target
- [Stellar CLI](https://developers.stellar.org/docs/tools/developer-tools/cli/stellar-cli)
- Node.js ≥ 20
- PostgreSQL

### 1. Clone & configure

```bash
git clone https://github.com/Soroban-Smart-Block-Explorer/Soroban-Smart-Block
cd Soroban-Smart-Block

# Root .env — used by Docker Compose
cp .env.example .env

# Indexer .env — used when running the indexer directly (npm start)
cp indexer/.env.example indexer/.env

# Frontend .env — sets the indexer URL for the Vite dev server
cp frontend/.env.example frontend/.env

# Edit all three files with your RPC URL, DATABASE_URL, and CONTRACT_ID
```

### 2. Build & deploy the contract

```bash
make build      # compile to WASM
make test       # run unit tests
make deploy     # deploy to testnet, prints CONTRACT_ID
```

Copy the printed contract ID into `.env` as `EXPLORER_CONTRACT_ID`.

#### Deployed Contracts

| Network | Contract ID | Explorer |
|---|---|---|
| Testnet | `CDA2ZCIB3ETZNFNQP4NS3SIEW5XCF7DKP5UWN4Y33F5FV34JA2CGAJ44` | [stellar.expert](https://stellar.expert/explorer/testnet/contract/CDA2ZCIB3ETZNFNQP4NS3SIEW5XCF7DKP5UWN4Y33F5FV34JA2CGAJ44) |

### 3. Start the indexer + API

```bash
make indexer-install
make indexer
```

### 4. Start the frontend

```bash
make frontend-install
make frontend
# Open http://localhost:5173
```

Or run both together:

```bash
make install
make dev
```

### Troubleshooting Local Development

#### Clean Database Reset

If your local database becomes out of sync with migrations or you need a clean slate:

```bash
make db-reset
```

This drops, recreates, and re-migrates the `soroban_explorer` database. Requires `DATABASE_URL` to be set (from `indexer/.env` or environment).

#### Seeding with Real Testnet Data

After resetting the database, you can optionally seed it with real Stellar testnet data:

```bash
make db-reset
make db-seed
```

The seed fixture is located in `seed-data/seed-data.fixture.json`. See [`seed-data/README.md`](seed-data/README.md) for instructions on populating the fixture with genuine data from Stellar testnet.

---

## Contract API

- Rustdoc reference: https://soroban-smart-block-explorer.github.io/Soroban-Smart-Block/docs/reference/contract/soroban_explorer_contract/

| Function                                       | Description                            |
| ---------------------------------------------- | -------------------------------------- |
| `init(admin)`                                  | Initialise contract with admin address |
| `register_contract(caller, contract_id, meta)` | Register ABI metadata for a contract   |
| `update_contract(caller, contract_id, meta)`   | Update metadata (admin or registrant)  |
| `get_contract(contract_id)`                    | Fetch contract metadata                |
| `submit_event(...)`                            | Persist a decoded event (admin only)   |
| `get_event(seq)`                               | Fetch event by sequence number         |
| `get_events(from, limit)`                      | Paginated event list                   |
| `event_count()`                                | Total stored events                    |

---

## REST API

| Endpoint                              | Description                |
| ------------------------------------- | -------------------------- |
| `GET /api/events?contract=&fn=&page=` | Paginated event list       |
| `GET /api/events/:seq`                | Single event               |
| `GET /api/contracts/:id`              | Contract ABI metadata      |
| `POST /api/contracts`                 | Register contract metadata |
| `GET /api/wallet/:address`            | Wallet event history       |

---

## SEP-41 Token Support

The decoder recognises SEP-41 token events (`transfer`, `mint`, `burn`) and formats amounts with the correct symbol, alongside classic Stellar assets fetched from Horizon.

---

## Validated Need & Traction

- **Confirmed gap:** StellarExpert and Stellar.expert (the two primary Stellar explorers) show
  raw XDR bytes for all Soroban contract events as of May 2026 — no human-readable decoding exists.
- **Community signal:** Developers in `#soroban-dev` on Stellar Discord regularly ask how to
  inspect their own contract events in a readable form. No existing tool answers this.
- **Comparable success:** Etherscan's ABI decoder is one of its most-used features. Solscan
  built the same for Solana and became the primary explorer for Solana DeFi. Stellar has no
  equivalent for Soroban.
- **Target users:** Soroban dApp developers, DeFi users, NFT traders, auditors — anyone who
  needs to understand what is happening on-chain.

---

## Detailed Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Stellar Network                                             │
│  ┌─────────────────────┐   ┌──────────────────────────────┐ │
│  │  Soroban RPC        │   │  Horizon API                 │ │
│  │  getEvents()        │   │  Classic asset metadata      │ │
│  │  getTransaction()   │   │  (asset codes, issuers)      │ │
│  └──────────┬──────────┘   └──────────────┬───────────────┘ │
└─────────────┼────────────────────────────┼─────────────────┘
              │ poll every 5 s             │ on-demand
┌─────────────▼────────────────────────────▼─────────────────┐
│  Indexer (Node.js)                                          │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  decoder.js                                          │  │
│  │  scValToNative(topic/data) → match ABI registry      │  │
│  │  → "Address GA… swapped 100 USDC → 98.7 XLM"        │  │
│  └──────────────────────┬───────────────────────────────┘  │
│  ┌──────────────────────▼───────────────────────────────┐  │
│  │  db.js  (PostgreSQL)                                 │  │
│  │  events table  ·  contracts table                    │  │
│  │  indexes on contract_id, function, ledger            │  │
│  └──────────────────────┬───────────────────────────────┘  │
│  ┌──────────────────────▼───────────────────────────────┐  │
│  │  api.js  (Express REST)                              │  │
│  │  GET /api/events  ·  GET /api/contracts/:id          │  │
│  │  GET /api/wallet/:address  ·  POST /api/contracts    │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────┬───────────────────────────────┘
                              │ REST /api/*
┌─────────────────────────────▼───────────────────────────────┐
│  React Frontend (Vite + TanStack Query)                     │
│  /              — paginated feed, function filter           │
│  /contract/:id  — ABI metadata + event history             │
│  /wallet/:addr  — all events for a Stellar address         │
│  /event/:seq    — full decoded event detail                 │
└─────────────────────────────────────────────────────────────┘
                              ▲
┌─────────────────────────────┴───────────────────────────────┐
│  Soroban Contract (Rust)  — on-chain source of truth        │
│  ContractRegistry  register_contract / get_contract         │
│  EventDecoder      submit_event / get_events / event_count  │
└─────────────────────────────────────────────────────────────┘
```

**Data flow for a decoded event:**

1. Soroban contract emits an event (e.g., `swap` on StellarSwap)
2. Indexer fetches it via `SorobanRpc.getEvents()`
3. `decoder.js` calls `scValToNative()` on topics/data, looks up registered ABI
4. Produces human-readable string → stored in PostgreSQL + submitted to on-chain contract
5. Frontend queries REST API and displays the decoded event

---

## SCF Submission Documents

| Document                             | Description                                        |
| ------------------------------------ | -------------------------------------------------- |
| [docs/ROADMAP.md](docs/ROADMAP.md)   | 3-tranche milestone plan (MVP → Testnet → Mainnet) |
| [docs/BUDGET.md](docs/BUDGET.md)     | Engineering hours and cost breakdown per tranche   |
| [docs/TEAM.md](docs/TEAM.md)         | Team bios and qualification evidence               |
| [docs/MANIFEST.md](docs/MANIFEST.md) | Full project manifest                              |
| [stellar.toml](stellar.toml)         | SEP-1 compliant network info                       |

---

## Documentation

A full developer documentation site lives under [`docs/`](docs/):

- [Architecture Decision Records](docs/adr/README.md) — rationale for the six core design choices behind the explorer.

- [Documentation home](docs/site/index.html) — guides, reference, and search.
- [Getting started](docs/guides/getting-started.md) and other step-by-step guides.
- [API playground](docs/api/playground.html) (Swagger UI) and an interactive
  [try-it console](docs/api/try-it.html) with curl / JS / Python / Rust snippets.
- [OpenAPI spec](docs/api/openapi.json) and [API changelog](docs/api/changelog.md).
- [Interactive architecture explorer](docs/site/architecture.html).

The site is published to GitHub Pages by
[`.github/workflows/docs.yml`](.github/workflows/docs.yml), which also generates
JSDoc (indexer) and Rustdoc (contract) reference.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow, commit conventions, and
PR checklist. Please open an issue first for large changes.

---

## License

[MIT](LICENSE)
