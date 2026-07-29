# Registering Your Contract's ABI

This guide walks you through registering a Soroban contract's ABI so the
Explorer decodes its events into readable text instead of raw XDR. It covers
the UI, the REST API, and the on-chain Stellar CLI path, in that order of
simplicity.

## What is an ABI in this context?

The Explorer doesn't have a global source of truth for what a contract's
functions and events mean — it has to be told. An "ABI" here is a small
metadata record:

- **`name`** / **`description`** — human-readable identification for the contract.
- **`functions`** — the list of callable functions, each with a `name`,
  `description`, and its ordered `params` (each a `name` + `kind`, e.g.
  `{ "name": "amount", "kind": "i128" }`).
- **`registered_by`** — the Stellar address that submitted the metadata.

Once registered, the indexer uses this metadata to turn a raw event like
`transfer(GABC…, GXYZ…, 1000000000)` into `"GABC… sent 100 USDC to GXYZ…"`.
Until a contract is registered, its events fall back to best-effort heuristic
decoding.

Two independent copies of this metadata exist:

- **Off-chain** — stored by the indexer in Postgres, used to decode events
  for the API and frontend. This is what "Register via the UI" and "Register
  via the REST API" below write to.
- **On-chain** — stored in the Explorer's own registry contract
  (`contracts/explorer`), useful if you want the ABI to live alongside your
  contract on Stellar itself rather than depend on the indexer's database.

You only need one of the two paths below to get decoding working. Register
on-chain only if you specifically want the metadata to be verifiable from the
ledger.

## Register via the UI

1. Open the Explorer frontend and navigate to **Contracts → Register
   Contract** (`/contracts/register`).
2. Fill in:
   - **Contract ID** — the 56-character Stellar strkey starting with `C`.
   - **Contract name** (required, ≤ 64 characters).
   - **Description** (optional, ≤ 512 characters).
   - **Registered by** — your Stellar address (optional; defaults to the
     contract ID if left blank).
   - **Function signatures** — add a row per function, with its parameter
     names and types, using the function table editor.
3. Click **Register contract**. On success you'll see a confirmation toast
   and be taken to the contract's detail page, where the ABI is now visible
   and any indexed events start decoding with it.

If the contract ID is already registered, or a field fails validation, the
form shows an inline error and nothing is submitted.

## Register via the REST API (with curl examples)

The UI above calls `POST /api/contracts` under the hood — you can call it
directly, which is useful for scripting registration as part of a deployment
pipeline.

```bash
curl -X POST http://localhost:3001/api/contracts \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d '{
    "id": "CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWX",
    "name": "StellarSwap DEX",
    "description": "Automated market maker for Soroban tokens.",
    "registered_by": "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWX",
    "functions": [
      {
        "name": "swap",
        "description": "Swap one token for another.",
        "params": [
          { "name": "caller", "kind": "address" },
          { "name": "amount_in", "kind": "i128" },
          { "name": "token_in", "kind": "address" },
          { "name": "amount_out", "kind": "i128" },
          { "name": "token_out", "kind": "address" }
        ]
      }
    ]
  }'
```

A successful call returns `201 Created` with `{ "ok": true }`. Registering an
ID that already exists returns `409 Conflict`; missing `id`/`functions` or a
failed on-chain ABI verification (see `VERIFY_ABI` below) returns `400 Bad
Request` with details.

Notes:

- `X-API-Key` is required — see [Building with the API](building-with-the-api.md)
  for how to obtain one.
- By default the indexer cross-checks submitted `functions` against the
  contract's on-chain WASM spec and rejects registrations that don't match.
  Set `VERIFY_ABI=false` in the indexer environment to disable this during
  local development against contracts you haven't deployed yet.
- To update an already-registered contract's ABI, use
  `PUT /api/contracts/:id` with the same body shape.

## Register on-chain via Stellar CLI

If you'd rather the ABI live on-chain in the Explorer's registry contract,
call `register_contract` directly with the [Stellar CLI](https://developers.stellar.org/docs/tools/cli/stellar-cli):

```bash
stellar contract invoke \
  --id "$EXPLORER_CONTRACT_ID" \
  --source default \
  --network testnet \
  -- register_contract \
  --caller "$YOUR_ADDRESS" \
  --contract_id "$TARGET_CONTRACT_ID" \
  --meta '{
    "version": 1,
    "abi_version": 0,
    "min_ledger": 0,
    "name": "StellarSwap DEX",
    "description": "Automated market maker for Soroban tokens.",
    "functions": [
      {
        "name": "swap",
        "description": "Swap one token for another.",
        "params": [
          { "name": "amount_in", "kind": "i128" },
          { "name": "token_in", "kind": "address" }
        ]
      }
    ],
    "registered_by": "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWX"
  }'
```

`$EXPLORER_CONTRACT_ID` is the deployed Explorer registry contract's ID for
the target network; `$YOUR_ADDRESS` must sign the transaction and is checked
against the registry's admin. The contract enforces size limits on `name`
(64 bytes), `description` (512 bytes), function count (50), and params per
function (20); anything larger is rejected. `abi_version` and `min_ledger`
are set by the contract itself on write and any values you pass are
overwritten.

| Function                                       | Description                            |
| ----------------------------------------------- | --------------------------------------- |
| `register_contract(caller, contract_id, meta)`  | Register ABI metadata (fails if it already exists) |
| `update_contract(caller, contract_id, meta)`    | Update metadata (admin or original registrant) |
| `get_contract(contract_id)`                     | Fetch the stored metadata               |

## Verify your registration

Off-chain (REST/UI path):

```bash
curl http://localhost:3001/api/contracts/$TARGET_CONTRACT_ID
curl "http://localhost:3001/api/contracts/$TARGET_CONTRACT_ID/events?page=1"
```

The first call should return the metadata you submitted; the second should
show newly-indexed events decoded using it — a `swap` invocation reads as a
sentence like `"GABC… swapped 100 USDC for 98.7 XLM"` instead of raw XDR.

On-chain path:

```bash
stellar contract invoke \
  --id "$EXPLORER_CONTRACT_ID" \
  --source default \
  --network testnet \
  -- get_contract \
  --contract_id "$TARGET_CONTRACT_ID"
```

This returns the stored `ContractMeta`, including the `abi_version` the
registry assigned on write.

## ABI schema reference

The REST/UI payload (`ContractMeta`) accepted by `POST /api/contracts`:

| Field            | Type                        | Required | Notes                                  |
| ---------------- | --------------------------- | -------- | --------------------------------------- |
| `id`              | string                      | yes      | Contract strkey (`C…`, 56 chars)        |
| `name`            | string                      | yes      | ≤ 64 characters                         |
| `description`     | string                      | no       | ≤ 512 characters                        |
| `registered_by`   | string                      | no       | Stellar address; defaults to `id`       |
| `functions`       | array of `FunctionAbi`      | yes      | See below                               |

`FunctionAbi`:

| Field         | Type               | Notes                          |
| ------------- | ------------------ | ------------------------------- |
| `name`        | string              | Function name as invoked on-chain |
| `description` | string              | ≤ 512 characters                |
| `params`      | array of `ParamDef` | Ordered to match the function signature |

`ParamDef`:

| Field  | Type   | Notes                                          |
| ------ | ------ | ----------------------------------------------- |
| `name` | string | Parameter name                                  |
| `kind` | string | Parameter type, e.g. `address`, `i128`, `u64`, `symbol` |

The on-chain `ContractMeta` (`contracts/explorer/src/lib.rs`) mirrors this
shape with two extra contract-managed fields, `abi_version` (incremented on
every update) and `min_ledger` (the ledger the version became active), both
of which are set by the registry contract and cannot be supplied by the
caller. The full Rust type definitions are the source of truth if this guide
and the code ever disagree.
