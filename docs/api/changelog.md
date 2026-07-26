# API Changelog

All notable changes to the Soroban Smart Block Explorer HTTP and WebSocket API are
documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the API follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The machine-readable contract lives in [`openapi.json`](./openapi.json) (generated
from `indexer/openapi.yaml`). Try endpoints live in the
[Swagger playground](./playground.html) or the [try-it console](./try-it.html).

## [Unreleased]

### Added

- This changelog and a generated OpenAPI 3.1 JSON document for tooling.
- `GET /api/contracts/{id}/stats` — event/caller counts and a 30-day daily
  activity series for a contract, cached for 5 minutes.
- `GET /api/contracts/{id}/storage-tiers` — write counts grouped by storage
  durability tier (temporary, persistent, instance).
- `GET /api/assets/{issuer}/{code}` — classic Stellar asset metadata resolved
  via Horizon, cached for 24 hours.

## [0.1.0]

### Added

- **Events**
  - `GET /api/events` — list contract events with offset pagination and filters
    (`contract`, `fn`, `type`, `page`).
  - `GET /api/v1/events` — cursor-paginated event listing.
  - `GET /api/events/{seq}` — full decoded event detail.
  - `GET /api/events/{seq}/zk-costs` — zero-knowledge cost breakdown for an event.
- **Contracts**
  - `GET /api/contracts/{id}` — contract metadata and ABI registry entry.
  - `GET /api/contracts/{id}/build-metadata` — reproducible build metadata.
  - `GET /api/contracts/{id}/abi` — decoded ABI for a contract.
  - `GET /api/contracts/{id}/transactions` — transaction history for a contract.
  - `GET /api/contracts/{id}/upgrades` — upgrade history.
  - `GET /api/contracts/{id}/ttl` — time-to-live and archival status.
  - `GET /api/contracts/{id}/state-diffs` — per-invocation state diffs.
  - `GET /api/contracts/{id}/circuit-breaker` — circuit-breaker status.
  - `GET /api/contracts/{id}/migration-status` — migration status.
  - `GET /api/contracts/{id}/rwa-metadata` — real-world-asset metadata.
- **Wallets and tokens**
  - `GET /api/wallet/{address}` — wallet transaction history.
  - `GET /api/tokens/{id}/holders` — token holder distribution.
  - `GET /api/tokens/{id}/volume` — token volume over time.
- **Tools**
  - `GET /api/spec/{id}` — contract interface specification.
  - `POST /api/verify` — verify a contract against published source.
  - `POST /api/simulate` — simulate a contract invocation.
  - `POST /api/sandbox/simulate` — sandboxed simulation.
  - `GET /api/auth-tree` — authorization tree for an invocation.
  - `GET /api/burn-alerts` — token burn alerts.
  - `GET /api/rpc-metrics` — RPC node metrics.
  - `GET /api/rpc-nodes` — configured RPC nodes.
- **WebSocket**
  - Live event stream over `ws(s)://<host>/?api_key=<key>`. Messages have the
    shape `{ "type": "event" | "vault_ratio" | "contract_link", "data": ... }`.

### Security

- Optional API key enforcement via the `X-API-Key` header on HTTP requests and the
  `api_key` query parameter on WebSocket connections.
- Per-IP rate limiting on the HTTP API.

## Versioning policy

- **Patch** releases cover backward-compatible fixes and additive response fields.
- **Minor** releases add new endpoints or optional parameters without breaking
  existing clients.
- **Major** releases may remove or change existing endpoints. Breaking changes are
  introduced under a new path prefix (for example `/api/v2/...`) where practical so
  older clients keep working during migration.

[Unreleased]: https://github.com/Soroban-Smart-Block-Explorer/Soroban-Smart-Block/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Soroban-Smart-Block-Explorer/Soroban-Smart-Block/releases/tag/v0.1.0
