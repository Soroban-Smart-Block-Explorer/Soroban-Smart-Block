/**
 * Bloat risk detection —
 *
 * Counts new persistent ContractDataEntry keys created by a single contract
 * invocation within one block. If the count exceeds BLOAT_THRESHOLD the
 * invocation is flagged as a potential state-bloat DoS vector.
 */

import { StrKey } from "@stellar/stellar-sdk";
import config from "./config.js";

export const BLOAT_THRESHOLD = config.BLOAT_THRESHOLD;

/**
 * Count persistent ContractDataEntry ledger changes for a specific contract
 * within a transaction's ledger-change set.
 *
 * The Soroban RPC event carries `txMeta` (TransactionMeta XDR). We inspect
 * the v3 soroban ledger changes for entries whose:
 *   - type       = CONTRACT_DATA
 *   - durability = PERSISTENT
 *   - change kind = CREATED (no prior state)
 *   - contract address matches `contractId`
 *
 * @param {object} ev          Raw Soroban RPC event
 * @param {string} contractId  Strkey-encoded contract ID to match
 * @returns {number}           Count of new persistent keys
 */
export function countNewPersistentKeys(ev, contractId) {
  try {
    const sorobanMeta = ev.txMeta?.v3?.().sorobanMeta?.();
    if (!sorobanMeta) return 0;

    // Decode the target contract ID to raw bytes once for comparison
    let targetBytes;
    try {
      targetBytes = StrKey.decodeContract(contractId);
    } catch {
      return 0;
    }

    const changes = sorobanMeta.changedEntries?.() ?? [];
    let count = 0;

    for (const change of changes) {
      try {
        // Only CREATED entries (no prior state = new key)
        const created = change.created?.();
        if (!created) continue;

        const contractData = created.data?.().contractData?.();
        if (!contractData) continue;

        // Must be persistent durability
        if (contractData.durability?.().name !== "persistent") continue;

        // Must belong to the contract being indexed
        const entryBytes = contractData.contract?.().contractId?.();
        if (!entryBytes) continue;
        if (!Buffer.from(entryBytes).equals(Buffer.from(targetBytes))) continue;

        count++;
      } catch {
        /* skip malformed entry */
      }
    }

    return count;
  } catch {
    return 0;
  }
}

/**
 * Returns true when a single invocation creates more than BLOAT_THRESHOLD
 * new persistent ContractDataEntry keys — a potential state-bloat DoS vector.
 *
 * @param {object} ev          Raw Soroban RPC event
 * @param {string} contractId  Strkey-encoded contract ID
 * @returns {boolean}
 */
export function isHighBloatRisk(ev, contractId) {
  return countNewPersistentKeys(ev, contractId) > BLOAT_THRESHOLD;
}
