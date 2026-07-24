/**
 * Vault / Treasury Indexer
 *
 * Monitors registered yield vault and tokenized treasury contracts,
 * computes real-time minting asset conversion ratios (total_assets / total_supply),
 * and surfaces the data through REST API + WebSocket events.
 *
 * Supported vault event patterns (Soroban):
 *   - `mint(admin, to, amount, shares)` / `deposit(admin, to, assets, shares)`
 *   - `burn(from, amount, shares)`     / `withdraw(admin, from, to, assets, shares)`
 *   - View functions: `total_assets()`, `total_supply()`, `get_underlying_asset()`
 */

import { rpc as SorobanRpc, Contract, nativeToScVal } from "@stellar/stellar-sdk";
import { db } from "./db.js";
import { publishVaultRatio } from "./wsEvents.js";
import { withRetry } from "./rpcRetry.js";

const RPC_URL = process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
const rpc = new SorobanRpc.Server(RPC_URL, { allowHttp: true });

// ── Helpers ──────────────────────────────────────────────────────────────────────

function bigintOrZero(val) {
  if (val == null) return 0n;
  try {
    const str = String(val);
    return /^\d+$/.test(str) ? BigInt(str) : 0n;
  } catch {
    return 0n;
  }
}

function computeRatio(assets, supply) {
  if (!supply || supply === 0n) return null;
  // Return ratio scaled to the contract's decimal precision as a Number
  return Number(assets) / Number(supply);
}

// ── On-chain view calls ──────────────────────────────────────────────────────────

/**
 * Simulate a read-only contract call via Soroban RPC.
 * @param {string} contractId
 * @param {string} fn          Function name
 * @param  {...any} args        Native JS args (converted to ScVal)
 * @returns {*} ScVal decoded to native
 */
async function simulateView(contractId, fn, ...args) {
  const contract = new Contract(contractId);
  const scArgs = args.map((a) => nativeToScVal(a, { type: { type: "val" } }));
  const op = contract.call(fn, ...scArgs);

  const source = process.env.SIMULATE_SOURCE || "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
  const account = await withRetry(() => rpc.getAccount(source));
  const { TransactionBuilder, Networks, BASE_FEE, scValToNative } = await import("@stellar/stellar-sdk");

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(op)
    .setTimeout(30)
    .build();

  const sim = await withRetry(() => rpc.simulateTransaction(tx));
  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(`Simulation error for ${contractId}.${fn}: ${sim.error}`);
  }

  const retval = sim.result?.retval;
  if (!retval) throw new Error(`No return value from ${contractId}.${fn}`);
  return scValToNative(retval);
}

/**
 * Fetch a vault's total assets under management.
 * Tries `total_assets` then `totalAssets` (camelCase variant).
 */
async function fetchTotalAssets(contractId) {
  try {
    return bigintOrZero(await simulateView(contractId, "total_assets"));
  } catch {
    try {
      return bigintOrZero(await simulateView(contractId, "totalAssets"));
    } catch {
      return null;
    }
  }
}

/**
 * Fetch a vault's total supply of shares.
 * Tries `total_supply` then `totalSupply`.
 */
async function fetchTotalSupply(contractId) {
  try {
    return bigintOrZero(await simulateView(contractId, "total_supply"));
  } catch {
    try {
      return bigintOrZero(await simulateView(contractId, "totalSupply"));
    } catch {
      return null;
    }
  }
}

/**
 * Optionally resolve the underlying asset address from the vault.
 */
async function fetchUnderlyingAsset(contractId) {
  try {
    const asset = await simulateView(contractId, "get_underlying_asset");
    return asset ? String(asset) : null;
  } catch {
    try {
      const asset = await simulateView(contractId, "underlyingAsset");
      return asset ? String(asset) : null;
    } catch {
      return null;
    }
  }
}

// ── Event detection ──────────────────────────────────────────────────────────────

const VAULT_MINT_EVENTS = new Set(["mint", "deposit"]);
const VAULT_BURN_EVENTS = new Set(["burn", "withdraw"]);

/**
 * Check if a decoded event touches a monitored vault contract.
 * If yes, recompute and persist the conversion ratio.
 *
 * @param {object} decoded  Decoded event from decoder.js
 */
export async function handleVaultEvent(decoded) {
  const { contract_id, function: fnName } = decoded;
  if (!contract_id) return;

  const activeIds = await db.getActiveVaultIds();
  if (!activeIds.includes(contract_id)) return;

  const isMint = VAULT_MINT_EVENTS.has(fnName);
  const isBurn = VAULT_BURN_EVENTS.has(fnName);
  if (!isMint && !isBurn) return;

  await refreshVaultRatio(contract_id, decoded.ledger);
}

// ── Ratio refresh ────────────────────────────────────────────────────────────────

/**
 * Query the vault's on-chain state and persist a snapshot with the computed ratio.
 * Publishes the ratio via WebSocket after storage.
 *
 * @param {string} contractId
 * @param {number} ledger
 */
export async function refreshVaultRatio(contractId, ledger) {
  try {
    const [totalAssets, totalSupply] = await Promise.all([fetchTotalAssets(contractId), fetchTotalSupply(contractId)]);

    if (totalAssets == null || totalSupply == null) return;

    const ratio = computeRatio(totalAssets, totalSupply);

    const snapshot = {
      contract_id: contractId,
      ledger,
      total_assets: String(totalAssets),
      total_supply: String(totalSupply),
      ratio,
    };

    await db.upsertVaultSnapshot(snapshot);
    publishVaultRatio(snapshot);

    console.log(
      `[vault] ${contractId.slice(0, 8)}… ratio=${ratio != null ? ratio.toFixed(6) : "N/A"} ` +
        `assets=${totalAssets} supply=${totalSupply} @ ledger=${ledger}`,
    );
  } catch (err) {
    console.error(`[vault] Failed to refresh ratio for ${contractId}: ${err.message}`);
  }
}

/**
 * Initialise a newly registered vault: discover underlying asset, take first snapshot.
 *
 * @param {string} contractId
 */
export async function bootstrapVault(contractId) {
  try {
    const ledger = await withRetry(() => rpc.getLatestLedger());
    const seq = ledger.sequence;

    const underlyingAsset = await fetchUnderlyingAsset(contractId);
    if (underlyingAsset) {
      await db.registerVault({
        contract_id: contractId,
        underlying_asset: underlyingAsset,
      });
    }

    await refreshVaultRatio(contractId, seq);
  } catch (err) {
    console.error(`[vault] Failed to bootstrap ${contractId}: ${err.message}`);
  }
}

/**
 * Catch-up pass: refresh ratios for all active vaults at the current ledger.
 */
export async function refreshAllVaults() {
  try {
    const ids = await db.getActiveVaultIds();
    if (ids.length === 0) return;

    const ledger = await withRetry(() => rpc.getLatestLedger());
    const seq = ledger.sequence;

    await Promise.allSettled(ids.map((id) => refreshVaultRatio(id, seq)));
  } catch (err) {
    console.error(`[vault] refreshAllVaults error: ${err.message}`);
  }
}
