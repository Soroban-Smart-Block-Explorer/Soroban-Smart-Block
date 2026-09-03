import { logger } from "./logger.js";
/**
 * contractVerifier.js
 *
 * Issue #519 — Background job that periodically calls get_contract on the
 * on-chain Soroban explorer contract for each registered contract and compares
 * the returned functions hash against the DB record.
 *
 * If they match → set is_verified = TRUE (with ledger number).
 * If they differ  → set is_verified = FALSE.
 *
 * The job runs every VERIFY_CRON minutes (default: every 15 minutes).
 * RPC_URL and CONTRACT_ID come from the same env vars used by the indexer.
 *
 * A lightweight functions-hash is computed by sorting function names and
 * JSON-stringifying the array — this avoids pulling the Soroban SDK into this
 * module while still catching real mismatches.
 */

import cron from 'node-cron';
import crypto from 'crypto';
import { db } from './db.js';

const VERIFY_CRON = process.env.VERIFY_CRON || '*/15 * * * *';
const RPC_URL = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
const CONTRACT_ID = process.env.EXPLORER_CONTRACT_ID || '';
const BATCH_SIZE = Number(process.env.VERIFY_BATCH_SIZE) || 20;

/** Compute a deterministic hash of a functions array for quick comparison. */
function hashFunctions(functions) {
  const sorted = (functions ?? [])
    .map((f) => (typeof f === 'string' ? f : f?.name ?? ''))
    .sort();
  return crypto.createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

/**
 * Fetch the on-chain ContractMeta for `contractId` from the explorer contract.
 * Returns null if the RPC call fails or the contract is not found on-chain.
 *
 * We invoke the `get_contract` function of the on-chain explorer contract using
 * a plain Soroban RPC simulateTransaction call. If the Soroban SDK is not
 * available (CI/test environments) we fall back to null gracefully.
 *
 * @param {string} contractId
 * @returns {Promise<{ functions: object[], ledger: number }|null>}
 */
async function fetchOnChainAbi(contractId) {
  if (!CONTRACT_ID || !RPC_URL) return null;

  try {
    // Dynamic import so this module can be loaded in test environments that
    // don't have the Stellar SDK installed.
    const { SorobanRpc, Contract, scValToNative, nativeToScVal } = await import(
      '@stellar/stellar-sdk'
    );

    const server = new SorobanRpc.Server(RPC_URL, { allowHttp: true });
    const contract = new Contract(CONTRACT_ID);

    const tx = await server.simulateTransaction(
      contract.call('get_contract', nativeToScVal(contractId, { type: 'string' })),
    );

    if (SorobanRpc.Api.isSimulationError(tx)) return null;
    if (!tx.result?.retval) return null;

    const native = scValToNative(tx.result.retval);
    const functions = native?.functions ?? native?.meta?.functions ?? [];
    const ledger = tx.latestLedger ?? 0;

    return { functions, ledger };
  } catch {
    // RPC unavailable, SDK not installed, or contract not found — skip
    return null;
  }
}

async function runVerificationBatch() {
  let page = 1;
  let processed = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { contracts } = await db.listContracts({ page, limit: BATCH_SIZE });
    if (!contracts.length) break;

    for (const contract of contracts) {
      try {
        const onChain = await fetchOnChainAbi(contract.id);
        if (onChain === null) {
          // Cannot reach on-chain data — skip this contract, preserve current state
          continue;
        }

        const dbHash = hashFunctions(
          typeof contract.functions === 'string'
            ? JSON.parse(contract.functions)
            : contract.functions ?? [],
        );
        const onChainHash = hashFunctions(onChain.functions);

        const isVerified = dbHash === onChainHash;
        await db.setContractVerified(contract.id, isVerified, isVerified ? onChain.ledger : null);
        processed++;
      } catch (err) {
        logger.error(`[verifier] Error verifying ${contract.id}:`, err.message);
      }
    }

    if (contracts.length < BATCH_SIZE) break;
    page++;
  }

  if (processed > 0) {
    logger.info(`[verifier] Verified ${processed} contracts`);
  }
}

/** Start the background verification cron job. */
export function startContractVerifier() {
  logger.info(`[verifier] Scheduling ABI verification (${VERIFY_CRON})`);
  // Run once on startup
  runVerificationBatch().catch((err) =>
    logger.error('[verifier] Initial verification batch failed:', err.message),
  );
  cron.schedule(VERIFY_CRON, () => {
    runVerificationBatch().catch((err) =>
      logger.error('[verifier] Verification batch failed:', err.message),
    );
  });
}
