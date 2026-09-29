# Reproducing a verified contract build

A contract's **Verified** badge means the explorer built the WASM from the
published source and its `sha256` equals the code hash deployed on-chain. You
can repeat that check yourself.

## Badge states

| Badge | Meaning |
|---|---|
| Verified (reproducible) | Two independent builds produced the same hash, and it equals the on-chain code hash. |
| Verified (hash match, non-reproducible toolchain) | The build matched the on-chain hash once, but a second build differed — some dependency is non-deterministic. |
| Mismatch | The built hash differs from the on-chain hash (both are shown). Also shown after an on-chain upgrade until the contract is re-verified. |
| Unverified | No verification exists. |
| Verification pending / failed | A build is queued, or it failed (reason and sanitized build log are shown). |

Only the verifier computes hashes. Submitting source coordinates never marks a
contract verified by itself.

## Reproduce it

The contract page shows the source repository, commit, toolchain and both
hashes. With Docker installed:

```bash
docker build -t ssb-verifier indexer/verifier
docker run --rm -e RUST_VERSION=<rust version> ssb-verifier <repo-url> <commit>
# → WASM_SHA256=<hex>
```

Compare the printed hash with the on-chain hash:

```bash
stellar contract fetch --id <contract-id> --network mainnet -o deployed.wasm
sha256sum deployed.wasm
```

## Requesting verification

```bash
curl -X POST https://<explorer>/api/contracts/<contract-id>/code-verifications \
  -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -d '{"source_repo":"https://github.com/org/repo","commit":"<40-char sha>","toolchain":{"rust":"1.84.0"}}'
```

One request per contract can be queued at a time. If the contract is upgraded
while its build runs, the result is discarded as stale and the build re-queued.
If the repository or commit disappears, the verification fails with "source no
longer retrievable" and earlier results keep their recorded hashes but are
flagged.
