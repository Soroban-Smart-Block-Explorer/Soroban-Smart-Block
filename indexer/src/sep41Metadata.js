/**
 * SEP-41 token metadata fetcher.
 * Uses read-only simulateTransaction to retrieve name, symbol, and decimals
 * from any SEP-41 compliant contract without spending fees.
 */
import { rpc as SorobanRpc, TransactionBuilder, Networks, Account, Contract, scValToNative } from "@stellar/stellar-sdk";
import { withRetry } from "./rpcRetry.js";

const RPC_URL = process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = process.env.NETWORK_PASSPHRASE || Networks.TESTNET;
// Dummy source account — simulation never submits, so balance doesn't matter
const DUMMY_SOURCE = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";

const rpc = new SorobanRpc.Server(RPC_URL, { allowHttp: true });

// In-memory cache: contractId → { decimals, symbol, name }
// Ensures the RPC call for decimals is only made once per contract across
// multiple events, satisfying the acceptance criteria for #568.
const _metadataCache = new Map();

/**
 * Simulate a no-arg contract call and return the native ScVal result.
 */
async function simulateCall(contractId, method) {
  const account = new Account(DUMMY_SOURCE, "0");
  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method))
    .setTimeout(30)
    .build();

  const result = await withRetry(() => rpc.simulateTransaction(tx));
  if (SorobanRpc.Api.isSimulationError(result)) {
    throw new Error(`simulate ${method} failed: ${result.error}`);
  }
  const retval = result.result?.retval;
  return retval ? scValToNative(retval) : null;
}

/**
 * Fetch SEP-41 token metadata for a given contract ID.
 * Results are cached per contract to avoid redundant RPC calls.
 * @param {string} contractId  Strkey-encoded contract address
 * @returns {Promise<{ name: string, symbol: string, decimals: number }>}
 */
export async function fetchTokenMetadata(contractId) {
  if (_metadataCache.has(contractId)) return _metadataCache.get(contractId);

  const [name, symbol, decimals] = await Promise.all([
    simulateCall(contractId, "name"),
    simulateCall(contractId, "symbol"),
    simulateCall(contractId, "decimals"),
  ]);

  const meta = {
    name: String(name ?? ""),
    symbol: String(symbol ?? ""),
    decimals: Number(decimals ?? 7),
  };
  _metadataCache.set(contractId, meta);
  return meta;
}

/**
 * Fetch only the decimals for a SEP-41 token contract.
 * Uses the metadata cache so only one RPC call is made per contract.
 * Falls back to 7 when the contract does not implement decimals().
 * @param {string} contractId  Strkey-encoded contract address
 * @returns {Promise<number>}
 */
export async function fetchDecimals(contractId) {
  const meta = await fetchTokenMetadata(contractId).catch(() => null);
  return meta?.decimals ?? 7;
}

/**
 * Returns the number of entries in the metadata cache.
 */
export function cacheSize() {
  return _metadataCache.size;
}
