# Testnet Deployment Runbook

This runbook captures the Stage 2 testnet deployment path for the Soroban Smart Block stack. It is written so a team member can redeploy, debug, or upgrade the testnet setup from a clean checkout.

## Prerequisites

Install and verify these tools before starting:

- Rust stable toolchain with the WebAssembly target: `rustup target add wasm32-unknown-unknown`.
- Stellar CLI 23.x or newer: `stellar --version`.
- Node.js 20 LTS or newer: `node --version` and `npm --version`.
- A Stellar testnet deployer/admin account.
- Network access to the Stellar testnet RPC endpoint.

Use a dedicated testnet secret for deployment work. Never reuse a mainnet secret in local shells, CI logs, or screenshots.

## Environment

Create a local environment file and keep secrets out of git:

```bash
cp .env.example .env
```

Set or map these values to the names used by the contract, indexer, and frontend packages:

```bash
STELLAR_NETWORK=testnet
STELLAR_RPC_URL=https://soroban-testnet.stellar.org
STELLAR_PASSPHRASE="Test SDF Network ; September 2015"
STELLAR_ADMIN_SECRET=<testnet-secret-key>
STELLAR_ADMIN_PUBLIC=<testnet-public-key>
CONTRACT_ID=<filled-after-deploy>
```

## 1. Build The WASM Contract

Install dependencies and build the contract package:

```bash
npm install
cargo build --release --target wasm32-unknown-unknown
```

If the contract lives in a workspace package, run the Cargo command from that package directory. Confirm that a release WASM artifact exists before deployment:

```bash
find . -path "*target/wasm32-unknown-unknown/release/*.wasm"
```

### Verified Build Reference

A clean release build of `soroban-explorer-contract` was verified at commit `002fc6a` (2026-07-21) per [#441](https://github.com/Soroban-Smart-Block-Explorer/Soroban-Smart-Block/issues/441):

| Field | Value |
| --- | --- |
| Artifact | `target/wasm32-unknown-unknown/release/soroban_explorer_contract.wasm` |
| Size | 30,778 bytes (~30 KB, well under the 100 KB budget) |
| SHA256 | `82dd8081e1af944a331905a69892b45ad9c115ee8e96cdb4ac7ba566bf41b2fd` |

This is a point-in-time record, not a guarantee for future builds — recompute the size and hash after any contract source change before deploying.

## 2. Deploy The Contract To Testnet

Configure the CLI and fund the deployer account if needed:

```bash
stellar network add testnet --rpc-url "$STELLAR_RPC_URL" --network-passphrase "$STELLAR_PASSPHRASE"
stellar keys add deployer --secret-key "$STELLAR_ADMIN_SECRET"
stellar keys fund deployer --network testnet
```

Deploy the WASM artifact:

```bash
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/soroban_smart_block.wasm \
  --source deployer \
  --network testnet
```

Copy the returned contract id:

```bash
export CONTRACT_ID=<returned-contract-id>
```

## 3. Initialize The Contract

Run the project initialization entrypoint with the testnet admin account. Replace function and argument names with the concrete names used by the current contract if they differ.

```bash
stellar contract invoke \
  --id "$CONTRACT_ID" \
  --source deployer \
  --network testnet \
  -- \
  initialize \
  --admin "$STELLAR_ADMIN_PUBLIC"
```

Verify initialized state with a read-only call, for example:

```bash
stellar contract invoke --id "$CONTRACT_ID" --source deployer --network testnet -- get_admin
```

Confirm the contract starts with zero recorded events:

```bash
stellar contract invoke --id "$CONTRACT_ID" --source deployer --network testnet -- event_count
```

The output must be `0`.

## 4. Fund The Admin Account

The admin account must have enough testnet XLM for initialization, upgrades, and operational calls.

```bash
stellar keys fund deployer --network testnet
stellar keys address deployer
```

If a separate admin key is used, fund that key as well.

## 5. Configure The Indexer

Create the indexer environment file and point it at the deployed contract:

```bash
cd indexer
cp .env.example .env
```

Set:

```bash
DATABASE_URL=<postgres-connection-string>
STELLAR_NETWORK=testnet
STELLAR_RPC_URL=https://soroban-testnet.stellar.org
STELLAR_PASSPHRASE="Test SDF Network ; September 2015"
CONTRACT_ID=<deployed-contract-id>
START_LEDGER=<deployment-ledger-or-earlier>
```

Install dependencies, run migrations, and start the daemon:

```bash
npm install
npm run migrate
npm run start
```

Leave the daemon running and confirm it advances through ledgers without repeatedly retrying the same event range.

## 6. Configure The Frontend

Create the frontend environment file:

```bash
cd frontend
cp .env.example .env.local
```

Set:

```bash
NEXT_PUBLIC_STELLAR_NETWORK=testnet
NEXT_PUBLIC_STELLAR_RPC_URL=https://soroban-testnet.stellar.org
NEXT_PUBLIC_CONTRACT_ID=<deployed-contract-id>
NEXT_PUBLIC_INDEXER_URL=<indexer-api-url>
```

Install, build, and serve:

```bash
npm install
npm run build
npm run start
```

For local validation during development, use `npm run dev` and verify that the app can read the deployed contract id and display indexed testnet data.

## 7. Smoke Test Checklist

- Contract WASM builds from a clean checkout.
- Contract id is recorded in the shared testnet environment.
- Initialization succeeds exactly once.
- Admin account is funded and can submit operational transactions.
- Indexer connects to the testnet RPC endpoint.
- Database migrations complete successfully.
- Indexer daemon processes ledgers beyond the deployment ledger.
- Frontend builds with the testnet contract id.
- Frontend reaches the indexer API.
- A second person can follow this document without private context.

## Troubleshooting

### Stellar CLI cannot find the network

Re-add the network and confirm the passphrase is testnet.

### Account has insufficient funds

Fund the testnet key again with `stellar keys fund deployer --network testnet`.

### WASM artifact is missing

Confirm the Rust target is installed and rebuild with `cargo build --release --target wasm32-unknown-unknown`.

### Contract invocation fails after deploy

Check that `CONTRACT_ID`, `STELLAR_NETWORK`, `STELLAR_RPC_URL`, and `STELLAR_PASSPHRASE` all point to testnet. A mainnet passphrase with a testnet RPC endpoint will fail.

### Indexer repeats the same ledger range

Check the database migration state, `START_LEDGER`, and any persisted cursor table. Restart only after confirming the cursor is not ahead of the testnet ledger.

### Frontend builds but shows no data

Confirm the frontend uses the same contract id as the indexer and that browser-accessible API URLs are not private Docker hostnames.

## Upgrading The Contract

After contract code changes, rebuild the WASM artifact:

```bash
cargo build --release --target wasm32-unknown-unknown
```

Upload the new WASM and invoke the project upgrade entrypoint if the contract exposes one:

```bash
stellar contract upload \
  --wasm target/wasm32-unknown-unknown/release/soroban_smart_block.wasm \
  --source deployer \
  --network testnet

stellar contract invoke \
  --id "$CONTRACT_ID" \
  --source deployer \
  --network testnet \
  -- \
  upgrade \
  --wasm-hash <uploaded-wasm-hash>
```

After the upgrade, re-run smoke checks, restart the indexer if event schemas changed, rebuild the frontend if generated bindings changed, and record the new WASM hash, contract id, deployer, and deployment ledger in release notes.