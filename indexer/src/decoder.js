import { scValToNative } from "@stellar/stellar-sdk";
import { db } from "./db.js";
import { detectSac, detectSacAsset } from "./sac.js";
import { extractRoleAssignment } from "./roleTracker.js";
import { decodeRwaEvent } from "./rwaDecoder.js";
import { parseHeuristic } from "./heuristicParser.js";
import { parseTTLHostFunction, formatTTLExtension } from "./ttlExtensionParser.js";
import { parseZkHostFunctions, computeZkCostDelta } from "./zkHostFunctions.js";
import { formatAmount } from "./formatAmount.js";
import { fetchDecimals } from "./sep41Metadata.js";
import { loadPlugins, runPlugins } from "./decoderPlugins.js";

// Result codes that indicate the block compute budget was exhausted.
const RESOURCE_LIMIT_CODES = new Set([
  "tx_resource_limit_exceeded",
  "txResourceLimitExceeded",
  "RESOURCE_LIMIT_EXCEEDED",
]);

/**
 * In-memory cache mapping contractId → decimals.
 * Populated lazily on first encounter of each SEP-41 token contract
 * via an on-chain decimals() call. The RPC call is only made once per
 * contract across multiple events (satisfies #568 acceptance criteria).
 * Falls back to 7 when the contract does not implement decimals().
 */
const tokenDecimalsCache = new Map();

/**
 * Returns true when the transaction was dropped because the block's total
 * resource budget was full.
 * @param {object} ev  Raw Soroban RPC event
 */
function isResourceLimitExceeded(ev) {
  const code = ev.txResultCode ?? ev.resultCode ?? ev.result?.code ?? "";
  return RESOURCE_LIMIT_CODES.has(String(code));
}

/**
 * JSON.stringify that survives BigInt values (i128/u64 amounts from
 * scValToNative) by serializing them as decimal strings, and strips
 * NUL characters (\u0000) which PostgreSQL text/jsonb columns reject.
 */
function safeStringify(value) {
  const json = JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v));
  return json ? json.replace(/\\u0000/g, "") : json;
}

/** Strip NUL characters that PostgreSQL rejects in text columns. */
function stripNul(str) {
  // eslint-disable-next-line no-control-regex -- intentionally strips NUL bytes
  return String(str).replace(/\u0000/g, "");
}

/**
 * Extract resource usage costs from the Soroban RPC event's transaction metadata.
 *
 * The Soroban RPC event object may carry a `feeCharged` field directly, and
 * the `txMeta` (TransactionMeta XDR) contains sorobanMeta with resource usage.
 * Fields:
 *   cpu_instructions — SorobanTransactionMeta.ext.v1.totalNonRefundableResourceFeeCharged
 *                      (non-refundable fees are proportional to CPU consumed)
 *   fee_charged      — SorobanTransactionMeta.ext.v1.totalRefundableResourceFeeCharged
 *   mem_bytes        — SorobanTransactionMeta.ext.v1.rentFeeCharged (rent ∝ memory)
 *
 * @param {object} ev  Raw Soroban RPC event
 * @returns {{ cpu_instructions?: number, mem_bytes?: number, fee_charged?: number }}
 */
function extractGasCosts(ev) {
  const result = {};

  try {
    if (ev.feeCharged != null) result.fee_charged = Number(ev.feeCharged);

    const meta = ev.txMeta;
    if (!meta) return result;

    let sorobanMeta = null;
    try {
      sorobanMeta = meta.v3?.().sorobanMeta?.() ?? null;
    } catch {
      /* not v3 */
    }

    if (!sorobanMeta) return result;

    try {
      const extV1 = sorobanMeta.ext?.().v1?.();
      if (extV1) {
        // Non-refundable fee is a proxy for CPU consumption
        if (extV1.totalNonRefundableResourceFeeCharged != null)
          result.cpu_instructions = Number(extV1.totalNonRefundableResourceFeeCharged);
        if (extV1.totalRefundableResourceFeeCharged != null)
          result.fee_charged = Number(extV1.totalRefundableResourceFeeCharged);
        // Rent fee is a proxy for memory/storage consumption
        if (extV1.rentFeeCharged != null)
          result.mem_bytes = Number(extV1.rentFeeCharged);
      }
    } catch {
      /* ext not v1 */
    }
  } catch {
    /* ignore all extraction errors */
  }

  return result;
}

// Native XLM Stellar Asset Contract IDs (testnet + mainnet)
const NATIVE_SAC_IDS = new Set([
  "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC", // testnet
  "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA", // mainnet
]);

/**
 * Format a token amount using the appropriate number of decimals.
 * Uses formatAmount from formatAmount.js for BigInt-safe formatting.
 */
function fmtTokenAmount(amount, decimals = 7) {
  if (amount == null) return "?";
  try {
    return formatAmount(amount, decimals);
  } catch {
    return String(amount);
  }
}

/**
 * Decode a raw Soroban RPC event into a human-readable record.
 * Uses the ABI template when available; falls back to a generic description.
 * @param {object} ev  Raw Soroban RPC event
 * @param {object} [opts]  Options: { failureReason, currentAbi }
 */
export async function decode(ev, { currentAbi = false, failureReason = null } = {}) {
  const contractId = ev.contractId;
  const topics = ev.topic.map((t) => scValToNative(t));
  const data = scValToNative(ev.value);

  // First topic is typically the function name symbol
  const fnName = typeof topics[0] === "symbol" || typeof topics[0] === "string" ? String(topics[0]) : "unknown";

  // Detect native XLM wrap/unwrap on the SAC contract
  if (NATIVE_SAC_IDS.has(contractId)) {
    const wrapUnwrap = nativeXlmDescription(fnName, topics.slice(1), data);
    if (wrapUnwrap) {
      return {
        contract_id: contractId,
        function: wrapUnwrap.function,
        ledger: ev.ledger,
        tx_hash: ev.txHash,
        description: wrapUnwrap.description,
        raw_topics: topics.map((t) => stripNul(t)),
        raw_data: safeStringify(data),
        ...extractGasCosts(ev),
      };
    }
  }

  // Look up registered ABI for richer description
  // Use versioned lookup: find the ABI version active at the event's ledger
  const meta = currentAbi
    ? await db.getContractMeta(contractId).catch(() => null)
    : await db
        .getContractMetaByLedger(contractId, ev.ledger)
        .catch(() => null) ?? await db.getContractMeta(contractId).catch(() => null);
  const fnAbi = meta?.functions?.find((f) => f.name === fnName);

  // Check if this contract is a registered vault
  const vaultMeta = await db.getVault(contractId).catch(() => null);

  const { isSac, assetCode } = detectSac(contractId);
  detectSacAsset(contractId);
  const contractLabel = vaultMeta?.name
    ? `${vaultMeta.name} (Vault)`
    : isSac
      ? `${assetCode} (SAC:${contractId.slice(0, 8)}…)`
      : (meta?.name ?? contractId);

  // #567: Run community plugins before built-in decoders
  let isDecoded = true;
  let description = null;
  try {
    const pluginResult = await runPlugins(ev, topics.slice(1), data, contractId);
    if (pluginResult) {
      description = pluginResult.description;
      if (pluginResult.function) {
        // Plugin override function name (e.g. "batch_approve_and_swap")
      }
    }
  } catch (err) {
    console.error("[decoderPlugins] plugin threw:", err.message);
  }

  // Try RWA decoder first (if no plugin matched)
  if (!description && meta) {
    const tempDecoded = {
      contract_id: contractId,
      function: fnName,
      raw_topics: topics.map((t) => stripNul(t)),
      raw_data: safeStringify(data),
    };
    description = decodeRwaEvent(tempDecoded, meta);
  }

  // Fall back to standard decoders
  if (!description) {
    // #568: Fetch decimals for token amount formatting
    let decimals = 7;
    if (!tokenDecimalsCache.has(contractId)) {
      try {
        decimals = await fetchDecimals(contractId);
        tokenDecimalsCache.set(contractId, decimals);
      } catch {
        decimals = 7;
      }
    } else {
      decimals = tokenDecimalsCache.get(contractId);
    }

    description = vaultMeta
      ? vaultDescription(fnName, topics.slice(1), data, contractLabel, vaultMeta)
      : fnAbi
        ? buildDescription(fnName, topics.slice(1), data, contractLabel, { decimals })
        : genericDescription(fnName, topics.slice(1), data, contractLabel);
  }

  // #565: XDR pretty-print fallback for unrecognised event types
  if (!fnAbi && !vaultMeta && !meta && !description) {
    description = xdrFallbackDescription(fnName, topics.slice(1), data, contractId);
    isDecoded = false;
  }

  // Attach heuristic params when no ABI was available
  const heuristicParams =
    !fnAbi && !vaultMeta && !meta ? parseHeuristic([...topics.slice(1), ...(data != null ? [data] : [])]) : undefined;

  const decoded = {
    contract_id: contractId,
    function: fnName,
    ledger: ev.ledger,
    tx_hash: ev.txHash,
    description,
    raw_topics: topics.map((t) => stripNul(t)),
    raw_data: safeStringify(data),
    ...(isSac && { sac_asset: assetCode }),
    is_clawback: fnName === "clawback",
    is_resource_limit_exceeded: isResourceLimitExceeded(ev),
    ...extractGasCosts(ev),
    ...(heuristicParams && { heuristic_params: heuristicParams }),
    // #566: Attach failure reason for failed transactions
    ...(failureReason && { is_failed: true, failure_reason: failureReason }),
    // #565: Mark undecoded events
    ...(!isDecoded && { decoded: false }),
  };

  // Protocol 26: detect TTL extension host function calls on this event
  const ttlExt = parseTTLHostFunction(ev.hostFunction ?? ev.host_function ?? ev.operation ?? null);
  if (ttlExt) {
    decoded.ttl_extension = ttlExt;
    decoded.description = formatTTLExtension(ttlExt);
  }

  // Protocol 26: detect CAP-0080 ZK host function calls
  const zkCalls = parseZkHostFunctions(ev);
  if (zkCalls) {
    decoded.zk_host_calls = {
      calls: zkCalls,
      delta: computeZkCostDelta(zkCalls),
    };
  }

  // Persist role assignment if this event carries one
  const roleAssignment = extractRoleAssignment(decoded);
  if (roleAssignment) {
    db.upsertRole({
      contract_id: contractId,
      ledger: ev.ledger,
      ...roleAssignment,
    }).catch((err) => console.error("[roleTracker] upsertRole failed:", err.message));
  }

  return decoded;
}

/**
 * Returns wrap/unwrap label and description for native XLM SAC events.
 * mint on native SAC = Classic XLM → Soroban (wrap)
 * burn on native SAC = Soroban → Classic XLM (unwrap)
 */
export function nativeXlmDescription(fnName, args, data) {
  if (fnName === "mint") {
    const [to, amount] = args;
    const amt = amount ?? data;
    return {
      function: "wrap_native",
      description: `Wrapped ${fmtXlm(amt)} XLM (Classic → Soroban) to ${fmt(to)}`,
    };
  }
  if (fnName === "burn") {
    const [from, amount] = args;
    const amt = amount ?? data;
    return {
      function: "unwrap_native",
      description: `Unwrapped ${fmtXlm(amt)} XLM (Soroban → Classic) from ${fmt(from)}`,
    };
  }
  return null;
}

function vaultDescription(fn, args, data, contractName, vaultMeta) {
  const assetLabel = vaultMeta.underlying_asset
    ? `asset ${vaultMeta.underlying_asset.slice(0, 6)}…${vaultMeta.underlying_asset.slice(-4)}`
    : "underlying asset";
  switch (fn) {
    case "mint":
    case "deposit": {
      const [admin, to, amount, shares] = args;
      return `Deposited ${String(amount ?? data ?? "?")} ${assetLabel} → minted ${String(shares ?? "?")} shares to ${fmt(to ?? admin)} on ${contractName}`;
    }
    case "burn":
    case "withdraw": {
      const [admin, from, to, assets, shares] = args.length >= 4 ? args : [null, null, args[0], args[1], args[2]];
      const amt = assets ?? data;
      const shr = shares ?? "?";
      return `Burned ${String(shr)} shares → withdrew ${String(amt)} ${assetLabel} from ${fmt(from ?? admin ?? to)} on ${contractName}`;
    }
    default:
      return genericDescription(fn, args, data, contractName);
  }
}

/**
 * Build a human-readable description from decoded ABI-matched function arguments.
 *
 * SEP-41 transfer format:
 *   "Address {short-from} transferred {amount} {token} to {short-to} on {contractName}"
 * where short addresses are truncated to "AAAAAA…ZZZZ" (6 + 4 chars).
 *
 * @param {string} fn        Function name
 * @param {any[]}  args      Decoded arguments (after topic[0])
 * @param {any}    data      Raw decoded data
 * @param {string} contractName  Display label for the contract
 * @param {object} [opts]    Options: { decimals } for token formatting (#568)
 */
export function buildDescription(fn, args, data, contractName, opts = {}) {
  const decimals = opts.decimals ?? 7;
  switch (fn) {
    case "swap": {
      const [from, amtIn, tokenIn, amtOut, tokenOut] = args;
      return `Address ${fmt(from)} swapped ${fmtTokenAmount(amtIn, decimals)} ${tokenIn} → ${fmtTokenAmount(amtOut, decimals)} ${tokenOut} on ${contractName}`;
    }
    case "transfer": {
      const [from, to, amount, token] = args;
      return `Address ${fmt(from)} transferred ${fmtTokenAmount(amount, decimals)} ${token ?? ""} to ${fmt(to)} on ${contractName}`;
    }
    case "mint": {
      const [to, amount, token] = args;
      return `${fmtTokenAmount(amount, decimals)} ${token ?? ""} minted to ${fmt(to)} on ${contractName}`;
    }
    case "burn": {
      const [from, amount, token] = args;
      return `${fmtTokenAmount(amount, decimals)} ${token ?? ""} burned from ${fmt(from)} on ${contractName}`;
    }
    case "clawback": {
      const [admin, from, amount, token] = args;
      return `CLAWBACK: ${fmtTokenAmount(amount, decimals)} ${token ?? ""} recovered from ${fmt(from)} by authority ${fmt(admin)} on ${contractName}`;
    }
    default:
      return genericDescription(fn, args, data, contractName);
  }
}

/**
 * #565: XDR pretty-print fallback for unrecognised event types.
 * Produces a human-readable description when no ABI or built-in decoder matched.
 */
function xdrFallbackDescription(fnName, args, data, contractId) {
  const argStr = args.map((a) => {
    if (a == null) return "null";
    if (typeof a === "string" && a.length > 20) return `${a.slice(0, 6)}…${a.slice(-4)}`;
    return String(a);
  }).join(", ");
  return `${fnName}(${argStr}) called on ${contractId.slice(0, 12)}…`;
}

function genericDescription(fn, args, data, contractId) {
  const argStr = args.map(String).join(", ");
  return `${fn}(${argStr}) called on ${contractId}`;
}

function fmt(addr) {
  if (typeof addr !== "string" || addr.length < 10) return String(addr);
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function fmtXlm(amount) {
  if (amount == null) return "?";
  // SAC amounts are in stroops (1 XLM = 10_000_000 stroops)
  const n = Number(amount);
  return isNaN(n) ? String(amount) : (n / 1e7).toLocaleString(undefined, { maximumFractionDigits: 7 });
}
