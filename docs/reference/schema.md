# Database Schema Reference

> Generated from the full migration set in `indexer/migrations/`.
> Last updated: 2026-07-28

---

## Entity-Relationship Diagram

```mermaid
erDiagram
    schema_migrations {
        TEXT version PK
        TIMESTAMPTZ applied_at
    }

    sandboxes {
        VARCHAR sandbox_id PK
        VARCHAR template_id
        JSONB files
        JSONB metadata
        TIMESTAMP created_at
        TIMESTAMP updated_at
    }

    events {
        BIGSERIAL seq PK
        TEXT contract_id FK
        TEXT function
        BIGINT ledger
        TEXT tx_hash
        TEXT description
        JSONB raw_topics
        TEXT raw_data
        BIGINT cpu_instructions
        BIGINT mem_bytes
        BIGINT fee_charged
        BOOLEAN is_high_bloat_risk
        JSONB upgrade_info
        JSONB storage_tiers
        BOOLEAN is_clawback
        BOOLEAN is_resource_limit_exceeded
        BOOLEAN footprint_contention
        JSONB ttl_extension
        JSONB fee_bump
        JSONB factory_deployment
        JSONB zk_host_calls
        JSONB archival_info
        TIMESTAMPTZ created_at
        BOOLEAN decoded
        INTEGER abi_version
        BOOLEAN needs_redecode
        TEXT caller_address
        INT slippage_bps
        TEXT batch_description
    }

    contracts {
        TEXT id PK
        TEXT name
        TEXT description
        JSONB functions
        TEXT registered_by
        JSONB source_files
        BOOLEAN has_circuit_breaker
        BOOLEAN is_paused
        BIGINT pause_status_ledger
        BOOLEAN is_rwa
        TEXT rwa_type
        TIMESTAMPTZ created_at
        INT version
        INT abi_version
        BIGINT min_ledger
        TEXT pause_trigger_tx_hash
        BIGINT pause_trigger_event_seq
        TEXT protocol_type
        BOOLEAN is_verified
        TIMESTAMPTZ verified_at
        INT verified_ledger
    }

    ledger_hashes {
        BIGINT ledger PK
        TEXT hash
        TIMESTAMPTZ indexed_at
    }

    daemon_state {
        TEXT key PK
        TEXT value
    }

    checkpoints {
        SERIAL id PK
        BIGINT ledger_sequence UK
        TIMESTAMP checkpoint_time
    }

    sub_invocations {
        BIGSERIAL id PK
        TEXT parent_tx_hash
        INT depth
        TEXT contract_id
        TEXT function
        JSONB args
        BIGINT ledger
        TIMESTAMPTZ created_at
    }

    source_verifications {
        BIGSERIAL id PK
        TEXT contract_id
        TEXT wasm_hash
        TEXT signer
        TEXT signature
        TEXT compiler_hash
        TIMESTAMPTZ submitted_at
    }

    storage_state_diffs {
        BIGSERIAL id PK
        TEXT contract_id
        BIGINT ledger
        TEXT tx_hash
        TEXT key
        TEXT tier
        TEXT old_value
        TEXT new_value
        TEXT change_type
        TIMESTAMPTZ created_at
    }

    quorum_freezes {
        BIGSERIAL id PK
        TEXT contract_id
        JSONB frozen_ids
        BIGINT ledger
        TEXT tx_hash
        BOOLEAN is_frozen
        TIMESTAMPTZ created_at
    }

    vaults {
        TEXT contract_id PK
        TEXT name
        TEXT underlying_asset
        INT decimals
        BOOLEAN active
        TIMESTAMPTZ created_at
        TIMESTAMPTZ updated_at
    }

    vault_snapshots {
        BIGSERIAL id PK
        TEXT contract_id FK
        BIGINT ledger
        TEXT total_assets
        TEXT total_supply
        TEXT ratio
        TIMESTAMPTZ created_at
    }

    token_holders {
        BIGSERIAL id PK
        TEXT contract_id
        TEXT address
        TEXT balance_raw
        TIMESTAMPTZ updated_at
        TEXT token_id
        JSONB metadata_json
        BIGINT last_transfer_ledger
    }

    privileged_roles {
        BIGSERIAL id PK
        TEXT contract_id
        TEXT role
        TEXT address
        BOOLEAN revoked
        BIGINT ledger
        TIMESTAMPTZ updated_at
    }

    wasm_build_metadata {
        TEXT wasm_hash PK
        TEXT contract_id
        TEXT sdk_version
        TEXT compiler
        TEXT optimizer
        TEXT repository
        TEXT commit
        JSONB producers
        BIGINT ledger
        TEXT tx_hash
        TIMESTAMPTZ created_at
        BIGINT size_bytes
    }

    api_keys {
        UUID id PK
        TEXT name
        TEXT key_hash
        CHAR key_prefix
        TEXT tier
        INTEGER rate_limit
        JSONB allowed_ips
        JSONB allowed_endpoints
        TIMESTAMPTZ expires_at
        BOOLEAN revoked
        TIMESTAMPTZ last_used_at
        BIGINT usage_count
        TIMESTAMPTZ created_at
        TIMESTAMPTZ updated_at
        TEXT email
        BOOLEAN verified
        TEXT verification_token UK
        TIMESTAMPTZ verification_expires_at
        INTEGER daily_limit
    }

    api_key_usage_daily {
        BIGSERIAL id PK
        UUID api_key_id FK
        DATE date
        BIGINT total_requests
        JSONB endpoint_distribution
        NUMERIC data_transfer_mb
        BIGINT rate_limit_hits
        INTEGER peak_concurrent
    }

    api_audit_log {
        BIGSERIAL id PK
        TIMESTAMPTZ timestamp PK
        UUID api_key_id
        TEXT key_name
        TEXT tier
        INET ip
        TEXT method
        TEXT endpoint
        SMALLINT status_code
        INTEGER response_time_ms
        INTEGER rate_limit_remaining
        TEXT user_agent
    }

    gap_log {
        BIGSERIAL id PK
        BIGINT from_ledger
        BIGINT to_ledger
        INT size
        TEXT status
        INT retries
        TIMESTAMPTZ closed_at
        TIMESTAMPTZ created_at
    }

    dead_letter_queue {
        BIGSERIAL id PK
        TEXT event_id
        TEXT contract_id
        BIGINT ledger
        TEXT tx_hash
        JSONB raw_event
        TEXT error_message
        TEXT error_code
        INT retry_count
        INT max_retries
        TIMESTAMPTZ next_retry_at
        BOOLEAN resolved
        TIMESTAMPTZ created_at
        TIMESTAMPTZ updated_at
    }

    contract_versions {
        SERIAL id PK
        TEXT contract_id FK
        INT abi_version
        BIGINT min_ledger
        TEXT name
        TEXT description
        JSONB functions
        TEXT registered_by
        TIMESTAMPTZ created_at
    }

    contract_abi_versions {
        BIGSERIAL id PK
        TEXT contract_id
        INT abi_version
        JSONB functions
        TEXT registered_by
        INT min_ledger
        TIMESTAMPTZ created_at
    }

    assets {
        TEXT code PK
        TEXT issuer PK
        TEXT name
        TEXT domain
        TEXT logo_url
        TIMESTAMPTZ resolved_at
        INTEGER decimals
        BIGINT id UK
    }

    api_key_usage {
        UUID api_key_id PK FK
        DATE date PK
        INT request_count
    }

    %% Relationships
    vault_snapshots ||--o| vaults : "contract_id"
    contract_versions ||--o| contracts : "contract_id"
    api_key_usage_daily ||--o| api_keys : "api_key_id"
    api_key_usage ||--o| api_keys : "api_key_id"
```

---

## Table Reference

### `schema_migrations`

Tracks which migration files have been applied to the database. Bootstrapped on first run of `migrate.js`.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `version` | `TEXT` | `PRIMARY KEY` | Migration filename (e.g. `002_core_schema.sql`) |
| `applied_at` | `TIMESTAMPTZ` | `DEFAULT NOW()` | Timestamp when the migration was applied |

---

### `sandboxes`

Stores user sandboxes with their code files and metadata for the browser-based IDE.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `sandbox_id` | `VARCHAR(32)` | `PRIMARY KEY` | Unique sandbox identifier |
| `template_id` | `VARCHAR(50)` | `NOT NULL` | Template used to create the sandbox |
| `files` | `JSONB` | `NOT NULL` | Sandbox file contents and structure |
| `metadata` | `JSONB` | `DEFAULT '{}'` | Additional metadata (tags, description, etc.) |
| `created_at` | `TIMESTAMP` | `DEFAULT NOW()` | Creation timestamp |
| `updated_at` | `TIMESTAMP` | `DEFAULT NOW()` | Last update timestamp (auto-updated via trigger) |

**Indexes:**
- `idx_sandboxes_created_at` — `(created_at DESC)`
- `idx_sandboxes_template` — `(template_id)`

---

### `events`

Core event store — every Soroban contract event decoded by the indexer is recorded here.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `seq` | `BIGSERIAL` | `PRIMARY KEY` | Monotonically increasing event sequence (used for keyset pagination) |
| `contract_id` | `TEXT` | `NOT NULL` | Soroban contract ID that emitted the event |
| `function` | `TEXT` | `NOT NULL` | Contract function name that triggered the event |
| `ledger` | `BIGINT` | `NOT NULL` | Stellar ledger sequence number |
| `tx_hash` | `TEXT` | | Transaction hash |
| `description` | `TEXT` | `NOT NULL` | Human-readable event description (decoded), max 2048 chars |
| `raw_topics` | `JSONB` | | Raw event topic vectors |
| `raw_data` | `TEXT` | | Raw event data (hex-encoded SCVal) |
| `cpu_instructions` | `BIGINT` | | CPU instructions consumed |
| `mem_bytes` | `BIGINT` | | Memory bytes used |
| `fee_charged` | `BIGINT` | | Fee charged for the transaction |
| `is_high_bloat_risk` | `BOOLEAN` | `DEFAULT FALSE` | Flag indicating high storage bloat risk |
| `upgrade_info` | `JSONB` | | Contract upgrade metadata |
| `storage_tiers` | `JSONB` | | Storage tier classification data |
| `is_clawback` | `BOOLEAN` | `DEFAULT FALSE` | Whether the event involves a clawback |
| `is_resource_limit_exceeded` | `BOOLEAN` | `DEFAULT FALSE` | Whether resource limits were exceeded |
| `footprint_contention` | `BOOLEAN` | `DEFAULT FALSE` | Whether footprint contention was detected |
| `ttl_extension` | `JSONB` | | TTL extension metadata |
| `fee_bump` | `JSONB` | | Fee bump transaction metadata |
| `factory_deployment` | `JSONB` | | Factory (contract deployer) deployment info |
| `zk_host_calls` | `JSONB` | | ZK host function call data |
| `archival_info` | `JSONB` | | Archival/eviction information |
| `created_at` | `TIMESTAMPTZ` | `DEFAULT NOW()` | Record creation timestamp |
| `decoded` | `BOOLEAN` | `DEFAULT TRUE` | Whether the event passed decoding validation |
| `abi_version` | `INTEGER` | `NOT NULL DEFAULT 0` | ABI version used for decoding |
| `needs_redecode` | `BOOLEAN` | `DEFAULT FALSE` | Whether the event needs re-decoding with newer ABI |
| `caller_address` | `TEXT` | | Stellar address of the transaction caller |
| `slippage_bps` | `INT` | | DEX swap slippage in basis points (NULL if unavailable) |
| `batch_description` | `TEXT` | | Combined description for multi-event batched transactions |

**Constraints:**
- `check_description_not_empty` — `CHECK (length(description) > 0)`
- `check_description_max_length` — `CHECK (length(description) <= 2048)`

**Indexes:**
- `idx_events_contract` — `(contract_id)`
- `idx_events_function` — `(function)`
- `idx_events_ledger` — `(ledger)`
- `idx_events_tx_hash` — `(tx_hash)`
- `idx_events_topic0` — `btree ((raw_topics->0))`
- `idx_events_contract_ledger` — `(contract_id, ledger DESC)`
- `idx_events_search_fts` — `GIN (to_tsvector('simple', ...))`
- `idx_events_ledger_sequence` — `(ledger DESC)`
- `idx_events_contract_id` — `(contract_id)`
- `idx_events_decoded` — `(decoded)`
- `idx_events_decoded_ledger` — `(decoded, ledger DESC)`
- `idx_events_seq_desc_contract_id` — `(seq DESC, contract_id)`
- `idx_events_needs_redecode` — `(contract_id) WHERE needs_redecode = TRUE`
- `idx_events_contract_caller` — `(contract_id, caller_address)`
- `idx_events_slippage_bps` — `(slippage_bps) WHERE slippage_bps IS NOT NULL`

---

### `contracts`

Registry of all known Soroban smart contracts with their metadata and ABI information.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | `TEXT` | `PRIMARY KEY` | Soroban contract ID |
| `name` | `TEXT` | `NOT NULL` | Human-readable contract name |
| `description` | `TEXT` | | Contract description |
| `functions` | `JSONB` | | Parsed function signatures from ABI |
| `registered_by` | `TEXT` | | Who registered the contract |
| `source_files` | `JSONB` | | Verified source code files |
| `has_circuit_breaker` | `BOOLEAN` | `DEFAULT FALSE` | Whether the contract has a circuit breaker |
| `is_paused` | `BOOLEAN` | `DEFAULT FALSE` | Current pause state |
| `pause_status_ledger` | `BIGINT` | | Ledger where pause state was last changed |
| `is_rwa` | `BOOLEAN` | `DEFAULT FALSE` | Whether this is a real-world asset contract |
| `rwa_type` | `TEXT` | | Type of real-world asset |
| `created_at` | `TIMESTAMPTZ` | `DEFAULT NOW()` | Record creation timestamp |
| `version` | `INT` | `NOT NULL DEFAULT 1` | Contract version number |
| `abi_version` | `INT` | `NOT NULL DEFAULT 0` | Current ABI version |
| `min_ledger` | `BIGINT` | `NOT NULL DEFAULT 0` | Minimum ledger for the current ABI |
| `pause_trigger_tx_hash` | `TEXT` | | Transaction hash that triggered the pause |
| `pause_trigger_event_seq` | `BIGINT` | | Event sequence that triggered the pause |
| `protocol_type` | `TEXT` | `CHECK (IN ('token','dex','lending','nft','bridge','other'))` | Protocol type classification |
| `is_verified` | `BOOLEAN` | `DEFAULT FALSE` | Whether on-chain verification passed |
| `verified_at` | `TIMESTAMPTZ` | | When verification was last performed |
| `verified_ledger` | `INT` | | Ledger at which verification was confirmed |

**Indexes:**
- `idx_contracts_search_fts` — `GIN (to_tsvector('simple', ...))`
- `idx_contracts_version` — `(version)`
- `idx_contracts_protocol_type` — `(protocol_type) WHERE protocol_type IS NOT NULL`
- `idx_contracts_protocol_type` — `(protocol_type)`
- `idx_contracts_is_verified` — `(is_verified) WHERE is_verified = TRUE`

---

### `ledger_hashes`

Tracks Stellar ledger hashes as they are indexed, used for reorg detection and verification.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `ledger` | `BIGINT` | `PRIMARY KEY` | Stellar ledger sequence number |
| `hash` | `TEXT` | `NOT NULL` | Ledger hash from the Soroban RPC |
| `indexed_at` | `TIMESTAMPTZ` | `DEFAULT NOW()` | When the ledger was indexed |

---

### `daemon_state`

General-purpose key-value store for the indexer daemon's persistent state (e.g., last processed ledger).

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `key` | `TEXT` | `PRIMARY KEY` | Configuration key |
| `value` | `TEXT` | `NOT NULL` | Configuration value |

---

### `checkpoints`

Tracks ledger checkpoint events for the checkpoint-based event processing pipeline.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | `SERIAL` | `PRIMARY KEY` | Auto-incrementing ID |
| `ledger_sequence` | `BIGINT` | `NOT NULL, UNIQUE` | Ledger sequence number at checkpoint |
| `checkpoint_time` | `TIMESTAMP` | `DEFAULT NOW()` | When the checkpoint was recorded |

**Indexes:**
- `checkpoints_ledger_sequence_idx` — `(ledger_sequence)`

---

### `sub_invocations`

Records sub-invocations — nested contract calls within a single transaction — for multi-contract transaction tracing.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | `BIGSERIAL` | `PRIMARY KEY` | Auto-incrementing ID |
| `parent_tx_hash` | `TEXT` | `NOT NULL` | Parent transaction hash |
| `depth` | `INT` | `NOT NULL DEFAULT 1` | Invocation depth (1 = top-level) |
| `contract_id` | `TEXT` | `NOT NULL` | Contract being invoked |
| `function` | `TEXT` | `NOT NULL` | Function being called |
| `args` | `JSONB` | | Function arguments (decoded) |
| `ledger` | `BIGINT` | `NOT NULL` | Ledger sequence number |
| `created_at` | `TIMESTAMPTZ` | `DEFAULT NOW()` | Record creation timestamp |

**Indexes:**
- `idx_sub_inv_parent` — `(parent_tx_hash)`
- `idx_sub_inv_contract` — `(contract_id)`

---

### `source_verifications`

Stores contract source code verification records — signed attestations linking a WASM hash to source code.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | `BIGSERIAL` | `PRIMARY KEY` | Auto-incrementing ID |
| `contract_id` | `TEXT` | `NOT NULL` | Contract ID being verified |
| `wasm_hash` | `TEXT` | `NOT NULL` | WASM bytecode hash |
| `signer` | `TEXT` | `NOT NULL` | Address that signed the verification |
| `signature` | `TEXT` | `NOT NULL` | Cryptographic signature |
| `compiler_hash` | `TEXT` | `NOT NULL` | Compiler version hash |
| `submitted_at` | `TIMESTAMPTZ` | `DEFAULT NOW()` | Submission timestamp |

**Constraints:**
- `UNIQUE (contract_id, wasm_hash, signer)`

**Indexes:**
- `idx_src_ver_contract` — `(contract_id)`

---

### `storage_state_diffs`

Tracks changes to contract storage state — key-value diffs per ledger.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | `BIGSERIAL` | `PRIMARY KEY` | Auto-incrementing ID |
| `contract_id` | `TEXT` | `NOT NULL` | Contract whose storage changed |
| `ledger` | `BIGINT` | `NOT NULL` | Ledger where the change occurred |
| `tx_hash` | `TEXT` | | Transaction that caused the change |
| `key` | `TEXT` | `NOT NULL` | Storage key (hex-encoded) |
| `tier` | `TEXT` | `NOT NULL` | Storage tier (Persistent/Temporary/Instance) |
| `old_value` | `TEXT` | | Previous value (NULL for new entries) |
| `new_value` | `TEXT` | | New value (NULL for deletions) |
| `change_type` | `TEXT` | `NOT NULL` | Type of change (created/updated/deleted) |
| `created_at` | `TIMESTAMPTZ` | `DEFAULT NOW()` | Record creation timestamp |

**Indexes:**
- `idx_state_diff_contract_ledger` — `(contract_id, ledger ASC)`

---

### `quorum_freezes`

Tracks quorum freeze events — when a set of signers freezes a contract's operations.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | `BIGSERIAL` | `PRIMARY KEY` | Auto-incrementing ID |
| `contract_id` | `TEXT` | `NOT NULL` | Contract that was frozen/unfrozen |
| `frozen_ids` | `JSONB` | `NOT NULL` | Set of signer addresses in the quorum |
| `ledger` | `BIGINT` | | Ledger where the freeze occurred |
| `tx_hash` | `TEXT` | | Transaction that triggered the freeze |
| `is_frozen` | `BOOLEAN` | `DEFAULT TRUE` | Whether the contract was frozen (or unfrozen) |
| `created_at` | `TIMESTAMPTZ` | `DEFAULT NOW()` | Record creation timestamp |

**Indexes:**
- `idx_quorum_freezes_contract` — `(contract_id)`

---

### `vaults`

Metadata for vault-type contracts (lending/strategy vaults).

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `contract_id` | `TEXT` | `PRIMARY KEY` | Vault contract ID |
| `name` | `TEXT` | | Human-readable vault name |
| `underlying_asset` | `TEXT` | | Contract ID of the underlying asset |
| `decimals` | `INT` | `DEFAULT 7` | Decimal precision |
| `active` | `BOOLEAN` | `DEFAULT TRUE` | Whether the vault is active |
| `created_at` | `TIMESTAMPTZ` | `DEFAULT NOW()` | Creation timestamp |
| `updated_at` | `TIMESTAMPTZ` | `DEFAULT NOW()` | Last update timestamp |

---

### `vault_snapshots`

Point-in-time snapshots of vault state (total assets, total supply, ratio).

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | `BIGSERIAL` | `PRIMARY KEY` | Auto-incrementing ID |
| `contract_id` | `TEXT` | `FOREIGN KEY → vaults(contract_id)` | Vault contract ID |
| `ledger` | `BIGINT` | `NOT NULL` | Ledger of the snapshot |
| `total_assets` | `TEXT` | `NOT NULL` | Total assets held (string for precision) |
| `total_supply` | `TEXT` | `NOT NULL` | Total supply of vault shares |
| `ratio` | `TEXT` | `NOT NULL` | Assets-to-supply ratio |
| `created_at` | `TIMESTAMPTZ` | `DEFAULT NOW()` | Record creation timestamp |

**Indexes:**
- `idx_vault_snapshots_contract` — `(contract_id, ledger DESC)`

---

### `token_holders`

Tracks token holder balances for both fungible tokens and NFTs.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | `BIGSERIAL` | `PRIMARY KEY` | Auto-incrementing ID |
| `contract_id` | `TEXT` | `NOT NULL` | Token contract ID |
| `address` | `TEXT` | `NOT NULL` | Holder's Stellar address |
| `balance_raw` | `TEXT` | `NOT NULL DEFAULT '0'` | Raw balance (string for large numbers) |
| `updated_at` | `TIMESTAMPTZ` | `DEFAULT NOW()` | Last balance update timestamp |
| `token_id` | `TEXT` | | NFT token ID (NULL for fungible tokens) |
| `metadata_json` | `JSONB` | | NFT metadata (NULL for fungible tokens) |
| `last_transfer_ledger` | `BIGINT` | | Last transfer ledger for NFT |

**Constraints:**
- `UNIQUE (contract_id, address)` — one row per holder per token

**Indexes:**
- `idx_token_holders_contract` — `(contract_id)`
- `idx_token_holders_nft` — `(contract_id, token_id) WHERE token_id IS NOT NULL`

---

### `privileged_roles`

Tracks privileged role assignments (admin, emergency, etc.) per contract.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | `BIGSERIAL` | `PRIMARY KEY` | Auto-incrementing ID |
| `contract_id` | `TEXT` | `NOT NULL` | Contract ID |
| `role` | `TEXT` | `NOT NULL` | Role type (admin, emergency, etc.) |
| `address` | `TEXT` | `NOT NULL` | Address assigned the role |
| `revoked` | `BOOLEAN` | `DEFAULT FALSE` | Whether the role has been revoked |
| `ledger` | `BIGINT` | | Ledger where the assignment was made |
| `updated_at` | `TIMESTAMPTZ` | `DEFAULT NOW()` | Last update timestamp |

**Constraints:**
- `UNIQUE (contract_id, role, address)`

**Indexes:**
- `idx_privileged_roles_contract` — `(contract_id)`

---

### `wasm_build_metadata`

Stores WASM build metadata for reproducible build verification.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `wasm_hash` | `TEXT` | `PRIMARY KEY` | SHA-256 hash of the WASM bytecode |
| `contract_id` | `TEXT` | | Contract ID this WASM belongs to |
| `sdk_version` | `TEXT` | | Soroban SDK version used |
| `compiler` | `TEXT` | | Compiler name and version |
| `optimizer` | `TEXT` | | Optimizer used |
| `repository` | `TEXT` | | Source code repository URL |
| `commit` | `TEXT` | | Git commit hash |
| `producers` | `JSONB` | | Build producer information |
| `ledger` | `BIGINT` | | Ledger where this WASM was first seen |
| `tx_hash` | `TEXT` | | Transaction that deployed the WASM |
| `created_at` | `TIMESTAMPTZ` | `DEFAULT NOW()` | Record creation timestamp |
| `size_bytes` | `BIGINT` | | WASM bytecode size in bytes |

**Indexes:**
- `idx_wasm_build_contract` — `(contract_id)`

---

### `api_keys`

Manages API keys for external access to the explorer API with tiered rate limiting.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | `UUID` | `PRIMARY KEY` | Unique API key ID (auto-generated) |
| `name` | `TEXT` | `NOT NULL` | Human-readable key name |
| `key_hash` | `TEXT` | `NOT NULL` | Hashed API key value |
| `key_prefix` | `CHAR(8)` | `NOT NULL` | First 8 characters of the raw key for identification |
| `tier` | `TEXT` | `NOT NULL DEFAULT 'free'` | Rate limit tier (unauthenticated/free/pro/enterprise) |
| `rate_limit` | `INTEGER` | | Per-key rate limit override |
| `allowed_ips` | `JSONB` | | Allowed IP CIDR ranges |
| `allowed_endpoints` | `JSONB` | | Allowed endpoint patterns |
| `expires_at` | `TIMESTAMPTZ` | | Key expiration timestamp |
| `revoked` | `BOOLEAN` | `NOT NULL DEFAULT FALSE` | Whether the key is revoked |
| `last_used_at` | `TIMESTAMPTZ` | | Last usage timestamp |
| `usage_count` | `BIGINT` | `NOT NULL DEFAULT 0` | Total request count |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT NOW()` | Creation timestamp |
| `updated_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT NOW()` | Last update timestamp |
| `email` | `TEXT` | | Email of the key owner |
| `verified` | `BOOLEAN` | `DEFAULT FALSE` | Whether the email has been verified |
| `verification_token` | `TEXT` | `UNIQUE` | Email verification token |
| `verification_expires_at` | `TIMESTAMPTZ` | | Verification token expiry |
| `daily_limit` | `INTEGER` | | Daily request limit |

**Indexes:**
- `idx_api_keys_prefix` — `(key_prefix)`
- `idx_api_keys_tier` — `(tier)`
- `idx_api_keys_verification_token` — `(verification_token)`
- `idx_api_keys_email` — `(email)`

---

### `api_key_usage_daily`

Daily aggregated API key usage statistics.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | `BIGSERIAL` | `PRIMARY KEY` | Auto-incrementing ID |
| `api_key_id` | `UUID` | `NOT NULL, FOREIGN KEY → api_keys(id) ON DELETE CASCADE` | API key reference |
| `date` | `DATE` | `NOT NULL` | Usage date |
| `total_requests` | `BIGINT` | `NOT NULL DEFAULT 0` | Total requests for the day |
| `endpoint_distribution` | `JSONB` | | Request count per endpoint |
| `data_transfer_mb` | `NUMERIC(12,3)` | `NOT NULL DEFAULT 0` | Data transferred in MB |
| `rate_limit_hits` | `BIGINT` | `NOT NULL DEFAULT 0` | Rate limit violation count |
| `peak_concurrent` | `INTEGER` | `NOT NULL DEFAULT 0` | Peak concurrent requests |

**Constraints:**
- `UNIQUE (api_key_id, date)`

**Indexes:**
- `idx_usage_daily_key_date` — `(api_key_id, date DESC)`

---

### `api_audit_log`

Partitioned audit log for all API requests. Partitioned monthly by `timestamp` range.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | `BIGSERIAL` | `PRIMARY KEY` (composite) | Auto-incrementing ID |
| `timestamp` | `TIMESTAMPTZ` | `NOT NULL, PRIMARY KEY` (composite) | Request timestamp |
| `api_key_id` | `UUID` | | API key used (NULL for unauthenticated) |
| `key_name` | `TEXT` | | Human-readable key name (historical) |
| `tier` | `TEXT` | `NOT NULL` | Rate limit tier at time of request |
| `ip` | `INET` | `NOT NULL` | Client IP address |
| `method` | `TEXT` | `NOT NULL` | HTTP method |
| `endpoint` | `TEXT` | `NOT NULL` | Request endpoint path |
| `status_code` | `SMALLINT` | `NOT NULL` | HTTP response status code |
| `response_time_ms` | `INTEGER` | `NOT NULL` | Response time in milliseconds |
| `rate_limit_remaining` | `INTEGER` | | Rate limit remaining at response |
| `user_agent` | `TEXT` | | Client user-agent string |

**Partitions:** Monthly partitions from `y2025m01` through `y2026m06`.

**Indexes:**
- `idx_audit_log_timestamp` — `(timestamp DESC)`
- `idx_audit_log_api_key_id` — `(api_key_id)`
- `idx_audit_log_ip` — `(ip)`
- `idx_audit_log_status_code` — `(status_code)`
- `idx_audit_log_endpoint` — `(endpoint)`

---

### `gap_log`

Tracks ledger gaps detected by the indexer — intervals where ledgers were missed and need remediation.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | `BIGSERIAL` | `PRIMARY KEY` | Auto-incrementing ID |
| `from_ledger` | `BIGINT` | `NOT NULL` | Start of the gap (inclusive) |
| `to_ledger` | `BIGINT` | `NOT NULL` | End of the gap (inclusive) |
| `size` | `INT` | `NOT NULL` | Number of ledgers in the gap |
| `status` | `TEXT` | `NOT NULL DEFAULT 'open'` | Gap status (open/closed/dlq) |
| `retries` | `INT` | `NOT NULL DEFAULT 0` | Number of retry attempts |
| `closed_at` | `TIMESTAMPTZ` | | When the gap was closed |
| `created_at` | `TIMESTAMPTZ` | `DEFAULT NOW()` | Record creation timestamp |

**Indexes:**
- `idx_gap_log_status` — `(status)`
- `idx_gap_log_from` — `(from_ledger)`
- `idx_gap_log_created` — `(created_at)`

---

### `dead_letter_queue`

Queue for events that failed processing, with retry mechanics.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | `BIGSERIAL` | `PRIMARY KEY` | Auto-incrementing ID |
| `event_id` | `TEXT` | | Original event identifier |
| `contract_id` | `TEXT` | | Contract that emitted the event |
| `ledger` | `BIGINT` | | Ledger of the failed event |
| `tx_hash` | `TEXT` | | Transaction hash of the failed event |
| `raw_event` | `JSONB` | `NOT NULL` | Raw event data |
| `error_message` | `TEXT` | `NOT NULL` | Error description |
| `error_code` | `TEXT` | | Error classification code |
| `retry_count` | `INT` | `NOT NULL DEFAULT 0` | Current retry attempt count |
| `max_retries` | `INT` | `NOT NULL DEFAULT 3` | Maximum retry attempts |
| `next_retry_at` | `TIMESTAMPTZ` | | When to retry next |
| `resolved` | `BOOLEAN` | `NOT NULL DEFAULT FALSE` | Whether the issue has been resolved |
| `created_at` | `TIMESTAMPTZ` | `DEFAULT NOW()` | Record creation timestamp |
| `updated_at` | `TIMESTAMPTZ` | `DEFAULT NOW()` | Last update timestamp |

**Indexes:**
- `idx_dlq_resolved` — `(resolved)`
- `idx_dlq_next_retry` — `(next_retry_at) WHERE resolved = FALSE`
- `idx_dlq_ledger` — `(ledger)`

---

### `contract_versions`

Tracks ABI version history for each contract, recording metadata changes across upgrades.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | `SERIAL` | `PRIMARY KEY` | Auto-incrementing ID |
| `contract_id` | `TEXT` | `FOREIGN KEY → contracts(id) ON DELETE CASCADE` | Contract ID |
| `abi_version` | `INT` | `NOT NULL` | ABI version number |
| `min_ledger` | `BIGINT` | `NOT NULL` | Minimum ledger this version applies from |
| `name` | `TEXT` | `NOT NULL` | Contract name at this version |
| `description` | `TEXT` | | Contract description at this version |
| `functions` | `JSONB` | | Function signatures at this version |
| `registered_by` | `TEXT` | | Who registered this version |
| `created_at` | `TIMESTAMPTZ` | `DEFAULT NOW()` | Record creation timestamp |

**Indexes:**
- `idx_contract_versions_contract_abi` — `(contract_id, abi_version)`
- `idx_contract_versions_contract_ledger` — `(contract_id, min_ledger)`

---

### `contract_abi_versions`

Snapshot of each ABI version's function signatures for historical queries.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | `BIGSERIAL` | `PRIMARY KEY` | Auto-incrementing ID |
| `contract_id` | `TEXT` | `NOT NULL` | Contract ID |
| `abi_version` | `INT` | `NOT NULL` | ABI version number |
| `functions` | `JSONB` | `NOT NULL DEFAULT '[]'` | Function signatures array |
| `registered_by` | `TEXT` | `NOT NULL DEFAULT ''` | Who registered this version |
| `min_ledger` | `INT` | `NOT NULL DEFAULT 0` | Minimum ledger this version applies from |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT NOW()` | Record creation timestamp |

**Constraints:**
- `UNIQUE (contract_id, abi_version)`

**Indexes:**
- `idx_contract_abi_versions_contract` — `(contract_id, abi_version ASC)`

---

### `assets`

Cache for classic Stellar asset metadata (code/issuer → display name, logo, decimals).

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `code` | `TEXT` | `PRIMARY KEY` (composite) | Asset code |
| `issuer` | `TEXT` | `PRIMARY KEY` (composite) | Issuer account ID |
| `name` | `TEXT` | | Human-readable asset name |
| `domain` | `TEXT` | | Issuer domain (from stellar.toml) |
| `logo_url` | `TEXT` | | Asset logo URL |
| `resolved_at` | `TIMESTAMPTZ` | `DEFAULT NOW()` | When metadata was resolved |
| `decimals` | `INTEGER` | `NOT NULL DEFAULT 7` | Asset decimal precision |
| `id` | `BIGINT` | `UNIQUE` | Monotonic ID for keyset pagination |

**Indexes:**
- `idx_assets_issuer` — `(issuer)`
- `idx_assets_id` — `UNIQUE (id)`

---

### `api_key_usage`

Daily per-key request count for rate limit enforcement.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `api_key_id` | `UUID` | `PRIMARY KEY (composite), FOREIGN KEY → api_keys(id) ON DELETE CASCADE` | API key reference |
| `date` | `DATE` | `PRIMARY KEY (composite)` | Usage date |
| `request_count` | `INT` | `NOT NULL DEFAULT 0` | Number of requests |

**Indexes:**
- `idx_api_key_usage_date` — `(date DESC)`

---

## Views

### `events_with_validation_issues`

View that identifies events with decoding or data corruption issues for monitoring.

```sql
CREATE OR REPLACE VIEW events_with_validation_issues AS
SELECT
  seq,
  contract_id,
  function,
  ledger,
  tx_hash,
  description,
  decoded,
  created_at,
  CASE
    WHEN decoded = FALSE THEN 'validation_failed'
    WHEN description LIKE '%<invalid decoded text>%' THEN 'recovered_from_corruption'
    WHEN description LIKE '%[object Object]%' THEN 'object_tostring_corruption'
    WHEN description LIKE '%undefined%' THEN 'undefined_corruption'
    ELSE 'unknown_issue'
  END as issue_type
FROM events
WHERE decoded = FALSE OR description LIKE '%[object Object]%'
   OR description LIKE '%undefined%'
   OR description LIKE '%<invalid decoded text>%';
```

---

## Sequences

| Sequence Name | Owned By | Description |
|---------------|----------|-------------|
| `assets_id_seq` | `assets.id` | Auto-incrementing ID generator for `assets` table |

---

# Migration Runbook

## Overview

The indexer uses a custom zero-downtime migration runner at `indexer/src/migrate.js`. Migrations are written as plain `.sql` files and stored in `indexer/migrations/`. The runner tracks applied migrations in a `schema_migrations` table that it bootstraps on first execution.

### How It Works

1. **Bootstrap**: On first run, the runner creates the `schema_migrations` tracking table if it does not exist:

    ```sql
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    );
    ```

2. **Discovery**: It reads all `.sql` files from `indexer/migrations/`, sorted alphabetically by filename.

3. **Filtering**: It queries `schema_migrations` for already-applied versions and skips those.

4. **Execution**: For each pending migration:
   - Acquires a dedicated database client from the pool
   - Begins a transaction (`BEGIN`)
   - Executes the SQL file
   - Records the migration in `schema_migrations`
   - Commits the transaction (`COMMIT`)
   - If any step fails, issues `ROLLBACK` and throws an error

5. **Completion**: Prints a message for each applied migration. If no migrations were needed, prints:

    ```
    [migrations] schema up to date
    ```

### Naming Convention

Migration files MUST follow this naming pattern to ensure correct ordering:

```
{NUMBER}_{DESCRIPTION}.sql
```

**Rules:**
- **Number**: Zero-padded, sequential integer (e.g., `001`, `002`, …, `025`).
  - Use the next number after the highest existing migration.
  - Numbers must be globally unique — never reuse or skip numbers.
  - The runner sorts by filename in **ascending alphabetic** order, so leading zeros are required.
- **Separator**: A single underscore `_` between the number and description.
- **Description**: Lowercase, underscore-separated, descriptive name (e.g., `core_schema`, `add_indexes`).
- **Extension**: Must be `.sql` (JavaScript `.js` files are **not** processed by the runner).

**Examples of valid names:**
```
001_create_sandboxes.sql
002_core_schema.sql
003_invocations_and_verifications.sql
025_api_key_usage.sql
```

### `node src/migrate.js` Behavior

The migration script can be invoked in two ways:

#### 1. Programmatic (imported by `index.js`)

```js
import { runMigrations } from './migrate.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const count = await runMigrations(pool);
// count === number of migrations applied
```

On startup, `index.js` calls `runMigrations(pool)` before beginning indexer operations. This ensures the schema is always up to date before processing events.

#### 2. CLI (standalone invocation)

```bash
node src/migrate.js
```

This loads `pg`, creates a pool from `DATABASE_URL`, runs all pending migrations, and exits:
- **Exit code 0**: All migrations applied successfully (or none pending).
- **Exit code 1**: A migration failed (error details printed to stderr).

#### What happens on an already-up-to-date database

When `migrate.js` runs against a database where all migrations have already been applied:

1. It queries `schema_migrations` and builds a `Set` of applied versions.
2. It scans `indexer/migrations/` for `.sql` files.
3. All files are filtered out (already in the applied set).
4. Prints: `[migrations] schema up to date`
5. Returns `0` (no migrations ran).
6. Exits with code `0`.

This is **idempotent** — running it repeatedly on a current database is safe and produces no side effects.

### How to Add a New Migration

1. **Create the SQL file** in `indexer/migrations/`:

    ```bash
    touch indexer/migrations/026_my_new_feature.sql
    ```

2. **Write the migration** — all DDL statements should be idempotent where possible:

    ```sql
    -- Migration 026: Add my_new_feature support
    -- Closes #XXX

    CREATE TABLE IF NOT EXISTS my_new_feature (
      id    BIGSERIAL PRIMARY KEY,
      name  TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_my_new_feature_name
      ON my_new_feature(name);
    ```

3. **Apply locally** to test:

    ```bash
    # Ensure DATABASE_URL is set in your .env
    node src/migrate.js
    ```

4. **Commit and push** the new migration file. The CI workflow `ci.yml` will automatically apply it on a fresh PostgreSQL 16 instance in the **Migrations** job, verifying it applies cleanly.

### How to Run Migrations Manually

#### Via the migration runner (recommended)

```bash
# From the indexer/ directory
cd indexer

# With DATABASE_URL set in environment or .env
DATABASE_URL="postgres://user:password@localhost:5432/soroban_explorer" node src/migrate.js
```

#### Directly with psql (for troubleshooting)

```bash
# Apply a single migration file
psql "$DATABASE_URL" -f indexer/migrations/026_my_new_feature.sql

# Manually record it in schema_migrations (only if it succeeded!)
psql "$DATABASE_URL" -c "INSERT INTO schema_migrations (version) VALUES ('026_my_new_feature.sql');"
```

> **Warning**: Applying migrations directly with `psql` bypasses the runner's transaction wrapping and idempotency checks. Only do this for emergency troubleshooting.

### Rollbacks

The migration runner does **not** support automatic rollbacks. Migrations are strictly additive (CREATE TABLE, ADD COLUMN, CREATE INDEX). To reverse a migration:

1. Write a new migration that reverts the change (e.g., `DROP TABLE IF EXISTS`, `ALTER TABLE … DROP COLUMN`).
2. Apply it using the normal migration process.

For local development rollbacks, you can manually execute the reverse DDL and delete the `schema_migrations` entry:

```sql
DELETE FROM schema_migrations WHERE version = '026_my_new_feature.sql';
```

---

## CI Integration

The **Migrations** job in `.github/workflows/ci.yml` automatically verifies all migrations on every pull request:

```yaml
migrations:
  name: Migrations (fresh PostgreSQL 16)
  runs-on: ubuntu-latest
  services:
    postgres:
      image: postgres:16-alpine
      env:
        POSTGRES_PASSWORD: test
      ports:
        - 5433:5432
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with:
        node-version: 20
    - name: Install indexer deps
      run: npm ci
      working-directory: indexer
    - name: Apply all migrations on a blank database
      env:
        DATABASE_URL: postgres://postgres:test@localhost:5433/postgres
      run: node src/migrate.js
      working-directory: indexer
```

This ensures that:
- Every `.sql` migration file applies without errors on a fresh PostgreSQL instance
- Migrations are order-independent when applied as a full set
- No missing-table or type conflicts exist between migrations
- The `schema_migrations` tracking table functions correctly
