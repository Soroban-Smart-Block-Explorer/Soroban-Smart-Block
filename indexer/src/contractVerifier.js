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
 * It also mirrors on-chain ownership claims (`get_ownership`, issue #875)
 * into ownership_verified / ownership_owner / ownership_method.
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
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { db } from './db.js';

const execFileAsync = promisify(execFile);

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

/**
 * Issue #875 — fetch the on-chain ownership claim for `contractId` from the
 * explorer contract's `get_ownership` view.
 *
 * @param {string} contractId
 * @returns {Promise<{ owner: string, method: string, ledger: number } | null | undefined>}
 *   the claim, `null` when the entry is unverified, or `undefined` when the
 *   RPC could not be reached (keep the stored state).
 */
async function fetchOnChainOwnership(contractId) {
  if (!CONTRACT_ID || !RPC_URL) return undefined;

  try {
    const { SorobanRpc, Contract, scValToNative, nativeToScVal } = await import(
      '@stellar/stellar-sdk'
    );

    const server = new SorobanRpc.Server(RPC_URL, { allowHttp: true });
    const contract = new Contract(CONTRACT_ID);

    const tx = await server.simulateTransaction(
      contract.call('get_ownership', nativeToScVal(contractId, { type: 'string' })),
    );

    if (SorobanRpc.Api.isSimulationError(tx) || !tx.result?.retval) return undefined;

    const native = scValToNative(tx.result.retval);
    if (!native) return null;
    // Unit enum variants decode as a one-element array, e.g. ['TargetAdmin'].
    const method = Array.isArray(native.method) ? native.method[0] : native.method;
    return { owner: String(native.owner), method: String(method), ledger: Number(native.ledger) };
  } catch {
    return undefined;
  }
}

async function runVerificationBatch() {
  let after;
  let processed = 0;

  while (true) {
    const { data: contracts, next_cursor } = await db.listContractsCursor({ after, limit: BATCH_SIZE });
    if (!contracts.length) break;

    for (const contract of contracts) {
      try {
        const ownership = await fetchOnChainOwnership(contract.id);
        if (ownership !== undefined) {
          await db.setContractOwnership(contract.id, ownership);
        }

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

    if (!next_cursor) break;
    after = next_cursor;
  }

  if (processed > 0) {
    logger.info(`[verifier] Verified ${processed} contracts`);
  }
}

// ── Issue #796: reproducible-build source verification ───────────────────────
//
// A verification request carries only source coordinates (repo, commit,
// toolchain). The verifier builds the WASM itself in a pinned container and
// compares sha256(wasm) with the code hash it fetches from the chain. Neither
// hash is ever accepted from the requester, so metadata alone can never
// produce a "Verified" badge.

const VERIFIER_BUILD_IMAGE = process.env.VERIFIER_BUILD_IMAGE || 'soroban-smart-block/verifier:latest';
const VERIFIER_BUILD_TIMEOUT_MS = Number(process.env.VERIFIER_BUILD_TIMEOUT_MS) || 20 * 60_000;
const MAX_LOG_CHARS = 20_000;

export const BADGE = {
  VERIFIED_REPRODUCIBLE: 'verified_reproducible',
  VERIFIED_HASH_MATCH: 'verified_hash_match',
  MISMATCH: 'mismatch',
  UNVERIFIED: 'unverified',
  PENDING: 'pending',
  FAILED: 'failed',
};

const HEX64 = /^[0-9a-f]{64}$/;
const REPO_URL = /^https:\/\/(github\.com|gitlab\.com|codeberg\.org)\/[\w.-]+\/[\w.-]+?(\.git)?$/;
const COMMIT = /^[0-9a-f]{40}$/;
const TOOLCHAIN_VALUE = /^[\w.+-]{1,64}$/;

/** Validate a verification request body. Returns an error string or null. */
export function validateVerificationRequest({ source_repo, commit, toolchain } = {}) {
  if (typeof source_repo !== 'string' || !REPO_URL.test(source_repo)) {
    return 'source_repo must be an https GitHub/GitLab/Codeberg repository URL';
  }
  if (typeof commit !== 'string' || !COMMIT.test(commit)) return 'commit must be a full 40-char hex SHA';
  if (toolchain !== undefined) {
    if (typeof toolchain !== 'object' || toolchain === null || Array.isArray(toolchain)) {
      return 'toolchain must be an object';
    }
    for (const [k, v] of Object.entries(toolchain)) {
      if (!['rust', 'soroban_sdk', 'stellar_cli'].includes(k) || typeof v !== 'string' || !TOOLCHAIN_VALUE.test(v)) {
        return 'toolchain may only contain rust, soroban_sdk, stellar_cli version strings';
      }
    }
  }
  return null;
}

/**
 * Scrub secrets and machine paths from a build log before it is stored or
 * shown.
 */
export function sanitizeBuildLog(log) {
  return String(log ?? '')
    .replace(/(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, '[REDACTED]')
    .replace(/AKIA[0-9A-Z]{16}/g, '[REDACTED]')
    .replace(/https?:\/\/[^\s/@:]+:[^\s/@]+@/g, 'https://[REDACTED]@')
    .replace(/\b([A-Z0-9_]*(SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*)=\S+/gi, '$1=[REDACTED]')
    .replace(/\/(home|Users)\/[^/\s]+/g, '/$1/[user]')
    .replace(/\/root\b/g, '/[root]')
    .slice(-MAX_LOG_CHARS);
}

/**
 * Compute the badge for a contract from the latest verification record and the
 * current on-chain code hash. Pure — the only inputs that can yield a verified
 * badge are verifier-computed hashes.
 *
 * @param {object|null} record  latest contract_code_verifications row
 * @param {string|null} onchainHash  current on-chain WASM hash (contract_code_state)
 */
export function computeBadge(record, onchainHash) {
  if (!record) return { state: BADGE.UNVERIFIED };
  if (record.status === 'pending' || record.status === 'building') return { state: BADGE.PENDING };
  if (record.status === 'failed') {
    // A failed re-check keeps no verified status, but the reason is surfaced.
    return { state: BADGE.FAILED, reason: record.reason ?? 'verification failed' };
  }
  const built = record.built_hash;
  const actual = onchainHash ?? record.onchain_hash;
  if (!built || !HEX64.test(built) || !actual || !HEX64.test(actual)) return { state: BADGE.UNVERIFIED };
  if (built !== actual) {
    return {
      state: BADGE.MISMATCH,
      expected: built,
      actual,
      upgraded: record.onchain_hash !== actual,
    };
  }
  return {
    state: record.reproducible ? BADGE.VERIFIED_REPRODUCIBLE : BADGE.VERIFIED_HASH_MATCH,
    source_retrievable: record.source_retrievable !== false,
  };
}

/**
 * Fetch the deployed WASM for a contract via RPC (getLedgerEntries on the
 * contract instance → code entry) and hash it.
 *
 * @returns {Promise<string|null>} hex sha256 of the on-chain code, or null
 */
export async function fetchOnChainCodeHash(contractId) {
  try {
    const { rpc } = await import('@stellar/stellar-sdk');
    const server = new rpc.Server(RPC_URL, { allowHttp: true });
    const wasm = await server.getContractWasmByContractId(contractId);
    return crypto.createHash('sha256').update(wasm).digest('hex');
  } catch {
    return null;
  }
}

/** Run one containerised build; returns the WASM sha256 and the raw log. */
async function runBuild({ source_repo, source_commit, toolchain }) {
  const env = [];
  for (const [k, v] of Object.entries(toolchain ?? {})) env.push('-e', `${k.toUpperCase()}_VERSION=${v}`);
  const { stdout, stderr } = await execFileAsync(
    'docker',
    ['run', '--rm', '--memory=4g', '--cpus=2', ...env, VERIFIER_BUILD_IMAGE, source_repo, source_commit],
    { timeout: VERIFIER_BUILD_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
  );
  const match = /WASM_SHA256=([0-9a-f]{64})/.exec(stdout);
  return { hash: match ? match[1] : null, log: `${stdout}\n${stderr}` };
}

function isSourceGone(err) {
  return /repository not found|not our ref|unadvertised object|couldn't find remote ref|reference is not a tree/i.test(
    `${err?.stdout ?? ''}${err?.stderr ?? ''}${err?.message ?? ''}`,
  );
}

async function completeVerification(id, fields) {
  const cols = Object.keys(fields);
  await db.query(
    `UPDATE contract_code_verifications
     SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, completed_at = NOW()
     WHERE id = $1`,
    [id, ...cols.map((c) => fields[c])],
  );
}

/**
 * Process one queued verification: build twice (reproducibility), compare
 * with the on-chain hash read before and after the build. If the contract was
 * upgraded mid-build the result is stale and the request is re-queued.
 */
export async function processNextVerification({ build = runBuild, fetchHash = fetchOnChainCodeHash } = {}) {
  const { rows } = await db.query(
    `UPDATE contract_code_verifications SET status = 'building'
     WHERE id = (
       SELECT id FROM contract_code_verifications WHERE status = 'pending'
       ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
  );
  const job = rows[0];
  if (!job) return null;

  const before = await fetchHash(job.contract_id);
  if (!before) {
    await completeVerification(job.id, { status: 'failed', reason: 'could not fetch on-chain code hash' });
    return job.id;
  }

  let first;
  let second;
  try {
    first = await build(job);
    second = first.hash ? await build(job) : null;
  } catch (err) {
    const gone = isSourceGone(err);
    await completeVerification(job.id, {
      status: 'failed',
      reason: gone ? 'source no longer retrievable' : 'build failed',
      source_retrievable: !gone,
      build_log: sanitizeBuildLog(`${err?.stdout ?? ''}\n${err?.stderr ?? err?.message ?? ''}`),
      onchain_hash: before,
    });
    if (gone) {
      // Earlier verified results keep their recorded hashes but are flagged.
      await db.query(
        `UPDATE contract_code_verifications SET source_retrievable = FALSE
         WHERE source_repo = $1 AND source_commit = $2`,
        [job.source_repo, job.source_commit],
      );
    }
    return job.id;
  }

  const after = await fetchHash(job.contract_id);
  if (after && after !== before) {
    // Upgraded between start and finish → stale; re-queue against the new code.
    await db.query(`UPDATE contract_code_verifications SET status = 'pending', reason = 'stale: contract upgraded during build' WHERE id = $1`, [job.id]);
    return job.id;
  }

  if (!first.hash) {
    await completeVerification(job.id, {
      status: 'failed',
      reason: 'build produced no WASM',
      build_log: sanitizeBuildLog(first.log),
      onchain_hash: before,
    });
    return job.id;
  }

  const reproducible = Boolean(second?.hash) && second.hash === first.hash;
  await completeVerification(job.id, {
    status: 'completed',
    reason: reproducible ? null : 'non-reproducible build: two builds produced different hashes',
    onchain_hash: before,
    built_hash: first.hash,
    reproducible,
    build_log: sanitizeBuildLog(first.log),
  });
  await recordOnChainHash(job.contract_id, before);
  return job.id;
}

/** Upsert the current on-chain code hash (verifier RPC read or upgrade event). */
export async function recordOnChainHash(contractId, wasmHash, ledger = null) {
  if (!HEX64.test(String(wasmHash))) return;
  await db.query(
    `INSERT INTO contract_code_state (contract_id, wasm_hash, ledger) VALUES ($1, $2, $3)
     ON CONFLICT (contract_id) DO UPDATE SET wasm_hash = $2, ledger = COALESCE($3, contract_code_state.ledger), updated_at = NOW()`,
    [contractId, wasmHash, ledger],
  );
}

/** Queue a verification request. Returns { id } or { error, status }. */
export async function requestVerification(contractId, body, requestedBy = null) {
  const error = validateVerificationRequest(body);
  if (error) return { status: 400, error };
  const { rows: open } = await db.query(
    `SELECT id FROM contract_code_verifications WHERE contract_id = $1 AND status IN ('pending', 'building') LIMIT 1`,
    [contractId],
  );
  if (open.length) return { status: 429, error: 'a verification for this contract is already queued', id: open[0].id };
  const { rows } = await db.query(
    `INSERT INTO contract_code_verifications (contract_id, source_repo, source_commit, toolchain, requested_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, status, created_at`,
    [contractId, body.source_repo, body.commit, JSON.stringify(body.toolchain ?? {}), requestedBy],
  );
  return { status: 202, ...rows[0] };
}

/** Badge + trust details for GET /api/contracts/:id/code-verification. */
export async function getCodeVerification(contractId) {
  const [{ rows: recs }, { rows: state }] = await Promise.all([
    db.query(
      `SELECT * FROM contract_code_verifications WHERE contract_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [contractId],
    ),
    db.query(`SELECT wasm_hash FROM contract_code_state WHERE contract_id = $1`, [contractId]),
  ]);
  const record = recs[0] ?? null;
  const onchain = state[0]?.wasm_hash ?? null;
  const badge = computeBadge(record, onchain);
  return {
    contract_id: contractId,
    badge,
    onchain_hash: onchain ?? record?.onchain_hash ?? null,
    built_hash: record?.built_hash ?? null,
    reproducible: record?.reproducible ?? null,
    toolchain: record?.toolchain ?? null,
    source_repo: record?.source_repo ?? null,
    commit: record?.source_commit ?? null,
    source_retrievable: record?.source_retrievable ?? null,
    built_at: record?.completed_at ?? null,
    reason: record?.reason ?? null,
    build_log: record?.status === 'failed' ? record.build_log : null,
    reproduce_doc:
      'https://github.com/Soroban-Smart-Block-Explorer/Soroban-Smart-Block/blob/main/docs/guides/reproduce-verified-build.md',
  };
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
  // Issue #796: drain the reproducible-build queue one job per minute.
  let building = false; // one build at a time per indexer instance
  cron.schedule('* * * * *', () => {
    if (building) return;
    building = true;
    processNextVerification()
      .catch((err) => logger.error('[verifier] Source verification job failed:', err.message))
      .finally(() => {
        building = false;
      });
  });
}
