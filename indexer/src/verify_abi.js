import { rpc as SorobanRpc, xdr, StrKey } from "@stellar/stellar-sdk";
import { withRetry } from "./rpcRetry.js";
import { parseContractSpec } from "./wasmContractSpec.js";

const RPC_URL = process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
const rpc = new SorobanRpc.Server(RPC_URL, { allowHttp: true });

/**
 * Fetch the raw WASM bytecode for a contract from the ledger.
 * Returns a Buffer with the WASM bytes, or null if not found.
 *
 * @param {string} contractId
 * @returns {Promise<Buffer|null>}
 */
async function fetchContractWasm(contractId) {
  // Step 1: get the contract instance to find the WASM hash
  const instanceKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new xdr.ScAddress({
        type: xdr.ScAddressType.scAddressTypeContract(),
        contractId: StrKey.decodeContract(contractId),
      }),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );

  const instanceRes = await withRetry(() => rpc.getLedgerEntries([instanceKey]));
  if (!instanceRes?.entries?.length) return null;

  const instanceEntry = instanceRes.entries[0].val;
  const contractData = instanceEntry.contractData();
  const scVal = contractData.val();
  if (scVal.switch().name !== "scvContractInstance") return null;

  const executable = scVal.contractInstance().executable();
  if (executable.switch().name !== "contractExecutableWasm") return null;

  const wasmHash = executable.wasmHash();

  // Step 2: fetch the WASM code entry by hash
  const codeKey = xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: wasmHash }));

  const codeRes = await withRetry(() => rpc.getLedgerEntries([codeKey]));
  if (!codeRes?.entries?.length) return null;

  const codeEntry = codeRes.entries[0].val;
  return Buffer.from(codeEntry.contractCode().code());
}

/**
 * Fetch the full on-chain spec for a contract, including custom types
 * (structs, enums, unions) parsed from the WASM binary.
 *
 * Returns { functions, types } where:
 *   functions: [{ name, doc?, inputs: [{name, type}], outputs: [type] }]
 *   types:     [{ kind: "struct"|"enum"|"union"|"error_enum", name, fields/cases }]
 *
 * Returns null if the contract doesn't exist or has no WASM.
 *
 * @param {string} contractId
 * @returns {Promise<{ functions: object[], types: object[] }|null>}
 */
export async function fetchContractSpecFull(contractId) {
  try {
    const wasm = await fetchContractWasm(contractId);
    if (!wasm) return null;
    return parseContractSpec(wasm);
  } catch (err) {
    console.error("Failed to fetch full contract spec:", err.message);
    return null;
  }
}

/**
 * Fetch the on-chain WASM spec for a contract.
 * Returns an array of { name: string, args: { name: string, type: string }[] }
 * or null if the contract doesn't exist.
 *
 * NOTE: This legacy function only returns function signatures. Use
 * fetchContractSpecFull() to also get custom struct/enum/union types.
 */
export async function fetchContractSpec(contractId) {
  try {
    const full = await fetchContractSpecFull(contractId);
    if (full === null) return null;

    // Map to the legacy shape expected by verifyAbi and the /api/spec/:id endpoint
    return full.functions.map((fn) => ({
      name: fn.name,
      args: (fn.inputs ?? []).map((i) => ({ name: i.name, type: i.type })),
    }));
  } catch (err) {
    console.error("Failed to fetch contract spec:", err.message);
    return null;
  }
}

/**
 * Verification result object.
 * @typedef {Object} VerificationResult
 * @property {boolean} valid - Whether the ABI passed verification
 * @property {string[]} errors - List of error messages if invalid
 * @property {Object[]} missingFunctions - Functions in ABI but not on-chain
 * @property {Object[]} argMismatch - Functions with mismatched argument counts
 */

/**
 * Verify an uploaded ABI against the on-chain contract spec.
 * @param {string} contractId - The contract ID (C... or hex)
 * @param {Object[]} abiFunctions - Array of { name: string, params: { name: string, kind: string }[] }
 * @returns {Promise<VerificationResult>}
 */
export async function verifyAbi(contractId, abiFunctions) {
  const spec = await fetchContractSpec(contractId);

  if (spec === null) {
    return {
      valid: false,
      errors: ["Contract not found on-chain or does not have a spec"],
      missingFunctions: [],
      argMismatch: [],
    };
  }

  const errors = [];
  const missingFunctions = [];
  const argMismatch = [];

  // Build a map of on-chain functions for quick lookup
  const specMap = new Map();
  for (const fn of spec) {
    specMap.set(fn.name, fn);
  }

  // Check each uploaded function
  for (const abiFn of abiFunctions) {
    const onChainFn = specMap.get(abiFn.name);

    if (!onChainFn) {
      missingFunctions.push({ name: abiFn.name });
      errors.push(`Function "${abiFn.name}" not found in on-chain spec`);
      continue;
    }

    // Compare argument counts
    const expectedArgs = onChainFn.args.length;
    const actualArgs = abiFn.params?.length || 0;

    if (expectedArgs !== actualArgs) {
      argMismatch.push({
        name: abiFn.name,
        expected: expectedArgs,
        actual: actualArgs,
      });
      errors.push(`Function "${abiFn.name}" has ${actualArgs} parameters but on-chain expects ${expectedArgs}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    missingFunctions,
    argMismatch,
  };
}

/**
 * Validate a single function name against the spec.
 * @returns {boolean} true if valid
 */
export function validateFunctionName(spec, functionName) {
  return spec.some((fn) => fn.name === functionName);
}

/**
 * Validate argument count for a function.
 * @returns {boolean} true if counts match
 */
export function validateArgCount(spec, functionName, argCount) {
  const fn = spec.find((f) => f.name === functionName);
  if (!fn) return false;
  return fn.args.length === argCount;
}
