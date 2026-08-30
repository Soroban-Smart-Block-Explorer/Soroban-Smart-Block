# Seed Data — Real Testnet Fixture

This directory contains the infrastructure for seeding the local dev database with **real Stellar testnet data**, not synthetic or generated data.

## Overview

- **`seed-data.fixture.json`** — JSON fixture file (currently empty placeholder).
- **`seed.js`** — Loads the fixture into the local database using the real indexer insertion methods.

## Status

⚠️ **The fixture file is intentionally EMPTY.** This session deliberately did not generate synthetic Stellar addresses or events, as that would violate the constraint against reintroducing fake-data generation (see issue #789).

A maintainer with access to Stellar testnet must populate the fixture file with genuine data.

## How to Populate the Fixture

### Prerequisites

- Docker Compose running the full stack (indexer connected to Soroban RPC)
- A small window of time to let the indexer poll and index real events from testnet

### Steps

1. **Start the indexer against real Soroban testnet** (it's the default in `.env.example`):
   ```bash
   make indexer-install
   make indexer
   ```
   Let it run for a few minutes to poll and index real Soroban events.

2. **Export a small sample of real events and contracts**:

   Connect to your local database and export both:

   ```bash
   # Export a small sample of real contracts (first 5–10)
   psql $(grep DATABASE_URL indexer/.env | cut -d= -f2) \
     -c "SELECT jsonb_build_object(
           'id', id,
           'name', name,
           'description', description,
           'functions', functions,
           'registered_by', registered_by,
           'source_files', source_files,
           'has_circuit_breaker', has_circuit_breaker,
           'is_rwa', is_rwa,
           'rwa_type', rwa_type,
           'version', version,
           'abi_version', abi_version,
           'min_ledger', min_ledger,
           'protocol_type', protocol_type
         ) FROM contracts LIMIT 10;" \
     | jq -s '.' > /tmp/contracts.json

   # Export a small sample of real events (first 20–50)
   psql $(grep DATABASE_URL indexer/.env | cut -d= -f2) \
     -c "SELECT jsonb_build_object(
           'contract_id', contract_id,
           'function', function,
           'ledger', ledger,
           'tx_hash', tx_hash,
           'description', description,
           'raw_topics', raw_topics,
           'raw_data', raw_data,
           'cpu_instructions', cpu_instructions,
           'mem_bytes', mem_bytes,
           'fee_charged', fee_charged,
           'is_high_bloat_risk', is_high_bloat_risk,
           'upgrade', upgrade_info,
           'storage_tiers', storage_tiers,
           'is_clawback', is_clawback,
           'footprint_contention', footprint_contention,
           'ttl_extension', ttl_extension,
           'fee_bump', fee_bump,
           'archival_info', archival_info,
           'zk_host_calls', zk_host_calls,
           'abi_version', abi_version,
           'slippage_bps', slippage_bps
         ) FROM events LIMIT 50;" \
     | jq -s '.' > /tmp/events.json
   ```

3. **Merge into the fixture file**:

   Manually edit `seed-data/seed-data.fixture.json` to combine the real contracts and events:

   ```json
   {
     "contracts": [ /* paste /tmp/contracts.json content */ ],
     "events": [ /* paste /tmp/events.json content */ ]
   }
   ```

   The `__INSTRUCTIONS__` key (if present) documents the constraint and can be removed.

4. **Verify and commit**:

   ```bash
   # Ensure the seed script loads correctly
   cd seed-data && node seed.js

   # Commit the real fixture
   git add seed-data/seed-data.fixture.json
   git commit -m "seed-data: populate fixture with real testnet sample"
   ```

## Using the Seed

Once the fixture is populated:

```bash
# Reset the database (drop, recreate, migrate)
make db-reset

# Seed the database with real data
cd seed-data && node seed.js

# Or via make (if a db-seed target is added to Makefile)
make db-seed
```

## Why Real Data?

- **No confusion**: Real addresses and events are unambiguous and trustworthy.
- **Schema fidelity**: Real data exercises every field the decoder and API actually handle.
- **Future-proof**: Synthetic data risks being mistaken for real data or copy-pasted as a template.

## Constraints

- **Never generate synthetic Stellar addresses**, event structs, or contract ABIs in this fixture, even as "examples" or "placeholders."
- The fixture must always contain either genuine testnet data or an explicit empty state (as it is now).
- If the fixture is empty, the seed script exits gracefully with a message.
