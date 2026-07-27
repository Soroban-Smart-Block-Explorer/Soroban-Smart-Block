import { scValToNative } from "@stellar/stellar-sdk";
import { db } from "./db.js";
import { detectSac, detectSacAsset } from "./sac.js";
import { extractRoleAssignment } from "./roleTracker.js";
import { decodeRwaEvent } from "./rwaDecoder.js";
import { parseHeuristic } from "./heuristicParser.js";
import { parseTTLHostFunction, formatTTLExtension } from "./ttlExtensionParser.js";
import { parseZkHostFunctions, computeZkCostDelta } from "./zkHostFunctions.js";
import { resolveAsset } from "./horizonClient.js";

// Classic operation types decoded from Horizon alongside Soroban events.
const PATH_PAYMENT_TYPES = new Set(["path_payment_strict_send", "path_payment_strict_receive"]);

// Result codes that indicate the block compute budget was exhausted.
const RESOURCE_LIMIT_CODES = new Set([
  "tx_resource_limit_exceeded",
  "txResourceLimitExceeded",
  "RESOURCE_LIMIT_EXCEEDED",
]);

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

// Function names recognised as DEX swaps for slippage computation (issue #554).
const SWAP_FUNCTIONS = new Set(["swap", "swap_exact_tokens_for_tokens"]);

// Minimum slippage worth surfacing in the description — anything at or below
// this is treated as normal execution variance rather than notable slippage.
const SLIPPAGE_DISPLAY_THRESHOLD_BPS = 10; // 0.1%

/**
 * Slippage in basis points: |amount_out - min_amount_out| / min_amount_out * 10000.
 * Returns null when either amount is missing/non-numeric or min_amount_out is zero
 * (slippage is undefined relative to a zero baseline).
 */
export function computeSlippageBps(amountOut, minAmountOut) {
  if (amountOut == null || minAmountOut == null) return null;
  const out = Number(amountOut);
  const minOut = Number(minAmountOut);
  if (!Number.isFinite(out) || !Number.isFinite(minOut) || minOut === 0) return null;
  return Math.round((Math.abs(out - minOut) / minOut) * 10000);
}

/**
 * Pulls amount_out (index 3) and min_amount_out (index 5) out of swap args —
 * shared by buildDescription() (for the inline text) and decode() (for the
 * persisted slippage_bps column) so the positional assumption lives in one place.
 */
export function extractSwapSlippageBps(args) {
  return computeSlippageBps(args?.[3], args?.[5]);
}

/** Renders " (slippage: 2.30%)" when bps is above the display threshold, else "". */
function formatSlippageSuffix(bps) {
  if (bps == null || bps <= SLIPPAGE_DISPLAY_THRESHOLD_BPS) return "";
  return ` (slippage: ${(bps / 100).toFixed(2)}%)`;
}

// Native XLM Stellar Asset Contract IDs (testnet + mainnet)
const NATIVE_SAC_IDS = new Set([
  "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC", // testnet
  "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA", // mainnet
]);

/**
 * Decode a raw Soroban RPC event into a human-readable record.
 * Uses the ABI template when available; falls back to a generic description.
 */
export async function decode(ev, { currentAbi = false } = {}) {
  // Classic Stellar operations (payments, path payments) carry no contract ID —
  // they arrive from Horizon rather than Soroban RPC's getEvents.
  if (ev.contractId == null && ev.operation) {
    return decodeClassicOperation(ev);
  }

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

  // Try RWA decoder first
  let description = null;
  if (meta) {
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
    description = vaultMeta
      ? vaultDescription(fnName, topics.slice(1), data, contractLabel, vaultMeta)
      : fnAbi
        ? buildDescription(fnName, topics.slice(1), data, contractLabel)
        : genericDescription(fnName, topics.slice(1), data, contractLabel);
  }

  // Attach heuristic params when no ABI was available
  const heuristicParams =
    !fnAbi && !vaultMeta && !meta ? parseHeuristic([...topics.slice(1), ...(data != null ? [data] : [])]) : undefined;

  // DEX swap slippage (issue #554) — only computable when the ABI-matched
  // swap args carry a min_amount_out (6th positional arg, see buildDescription).
  const slippageBps =
    fnAbi && SWAP_FUNCTIONS.has(fnName) ? extractSwapSlippageBps(topics.slice(1)) : null;

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
    ...(slippageBps != null && { slippage_bps: slippageBps }),
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

/**
 * Decode a classic Stellar payment/path-payment operation sourced from
 * Horizon (contractId is null — there is no Soroban contract involved).
 *
 * @param {object} ev
 * @param {number} ev.ledger
 * @param {string} ev.txHash
 * @param {object} ev.operation  Horizon operation record (payment | path_payment_strict_send | path_payment_strict_receive)
 */
export async function decodeClassicOperation(ev) {
  const op = ev.operation;
  const description = PATH_PAYMENT_TYPES.has(op.type)
    ? await pathPaymentDescription(op)
    : await paymentDescription(op);

  return {
    contract_id: "",
    function: op.type,
    ledger: ev.ledger,
    tx_hash: ev.txHash,
    description,
    raw_topics: [op.type, op.from, op.to].filter((t) => typeof t === "string"),
    raw_data: safeStringify(op),
    type: "classic",
  };
}

/** Resolve a classic asset to its display label, e.g. "USDC (Centre Consortium)". */
async function classicAssetLabel(code, issuer, assetType) {
  if (!code || !issuer || assetType === "native") return "XLM";
  const resolved = await resolveAsset(code, issuer).catch(() => null);
  return resolved?.name ? `${code} (${resolved.name})` : code;
}

async function paymentDescription(op) {
  const label = await classicAssetLabel(op.asset_code, op.asset_issuer, op.asset_type);
  return `Address ${fmt(op.from)} sent ${fmtClassicAmount(op.amount)} ${label} to ${fmt(op.to)}`;
}

async function pathPaymentDescription(op) {
  const sourceLabel = await classicAssetLabel(op.source_asset_code, op.source_asset_issuer, op.source_asset_type);
  const destLabel = await classicAssetLabel(op.asset_code, op.asset_issuer, op.asset_type);
  const path = Array.isArray(op.path) ? op.path : [];
  const pathLabels = await Promise.all(path.map((hop) => classicAssetLabel(hop.asset_code, hop.asset_issuer, hop.asset_type)));
  const bracket = pathLabels.length ? ` → [${pathLabels.join(" → ")}]` : "";

  const sourceAmount = fmtClassicAmount(op.source_amount ?? op.amount);
  const destAmount = fmtClassicAmount(op.amount);

  return `${fmt(op.from)} swapped ${sourceAmount} ${sourceLabel}${bracket} → ${destAmount} ${destLabel}`;
}

/** Format a Horizon decimal amount string (e.g. "100.0000000") for display. */
function fmtClassicAmount(amount) {
  if (amount == null) return "?";
  const n = Number(amount);
  return isNaN(n) ? String(amount) : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 7 });
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
 */
export function buildDescription(fn, args, data, contractName) {
  switch (fn) {
    case "swap":
    case "swap_exact_tokens_for_tokens": {
      const [from, amtIn, tokenIn, amtOut, tokenOut] = args;
      const slippageBps = extractSwapSlippageBps(args);
      return `Address ${fmt(from)} swapped ${amtIn} ${tokenIn} → ${amtOut} ${tokenOut} on ${contractName}${formatSlippageSuffix(slippageBps)}`;
    }
    case "transfer": {
      const [from, to, amount, token] = args;
      return `Address ${fmt(from)} transferred ${amount} ${token ?? ""} to ${fmt(to)} on ${contractName}`;
    }
    case "mint": {
      const [to, amount, token] = args;
      return `${amount} ${token ?? ""} minted to ${fmt(to)} on ${contractName}`;
    }
    case "burn": {
      const [from, amount, token] = args;
      return `${amount} ${token ?? ""} burned from ${fmt(from)} on ${contractName}`;
    }
    case "clawback": {
      const [admin, from, amount, token] = args;
      return `CLAWBACK: ${amount} ${token ?? ""} recovered from ${fmt(from)} by authority ${fmt(admin)} on ${contractName}`;
    }
    case "stake":
    case "lock":
    case "deposit_stake": {
      const [addr, amount, duration] = args;
      const amt = amount ?? data;
      if (duration != null && duration !== 0) {
        return `${fmt(addr)} staked ${fmtXlm(amt)} XLM for ${duration} days on ${contractName}`;
      }
      return `${fmt(addr)} staked ${fmtXlm(amt)} XLM on ${contractName}`;
    }
    case "unstake":
    case "unlock": {
      const [addr, amount, rewards] = args;
      const amt = amount ?? data;
      if (rewards != null && rewards !== 0) {
        return `${fmt(addr)} unstaked ${fmtXlm(amt)} XLM + ${fmtXlm(rewards)} XLM rewards on ${contractName}`;
      }
      return `${fmt(addr)} unstaked ${fmtXlm(amt)} XLM on ${contractName}`;
    }
    default:
      // NFT transfer detection: transfer event that carries a token_id field
      // (u64 / number) is treated as an NFT transfer rather than a fungible
      // token transfer (issue #562 detection heuristic).
      if (fn === "transfer") {
        const [from, to, amount, token] = args;
        const tokenId = args.find(
          (a) => typeof a === "bigint" || (typeof a === "number" && Number.isInteger(a) && a >= 0)
        );
        if (tokenId !== undefined && tokenId !== amount) {
          return buildNftDescription("transfer", args, data, contractName);
        }
        return `Address ${fmt(from)} transferred ${amount} ${token ?? ""} to ${fmt(to)} on ${contractName}`;
      }
      return genericDescription(fn, args, data, contractName);
  }
}

// ── SEP-41 allowance helpers (issue #561) ─────────────────────────────────────

/**
 * Produces human-readable descriptions for SEP-41 approve/allowance events.
 *
 * Approve with amount > 0:
 *   "GA… approved GB… to spend up to 500 USDC (expires ledger #N)"
 *   "GA… approved GB… to spend up to 500 USDC (no expiry)"  (when expiration_ledger is 0/null)
 * Revoke (amount === 0 or 0n):
 *   "GA… revoked GB…'s allowance to spend USDC"
 * increase_allowance:
 *   "GA… increased GB…'s allowance by 100 USDC"
 * decrease_allowance:
 *   "GA… decreased GB…'s allowance by 100 USDC"
 *
 * Argument order follows the SEP-41 spec:
 *   approve(from, spender, amount, expiration_ledger)
 *   set_allowance(from, spender, amount, expiration_ledger)
 *   increase_allowance(from, spender, amount)
 *   decrease_allowance(from, spender, amount)
 *
 * @param {string} fn         Function name
 * @param {any[]}  args       Decoded arguments (topics[1..] or data)
 * @param {any}    _data      Raw decoded data (unused but kept for signature parity)
 * @param {string} contractName  Display label for the contract / token symbol
 */
function buildAllowanceDescription(fn, args, _data, contractName) {
  // Normalise: pull from data object if args arrived as a single object
  let from, spender, amount, expirationLedger, token;

  if (args.length === 1 && typeof args[0] === "object" && args[0] !== null) {
    // Data packed into a map (scvMap → native object)
    ({ from, spender, amount, expiration_ledger: expirationLedger, token } = args[0]);
  } else {
    [from, spender, amount, expirationLedger, token] = args;
  }

  // Token label: use explicit token arg, or fall back to the contract label
  const tokenLabel = token ?? contractName;

  const owner = fmt(from);
  const spenderFmt = fmt(spender);

  if (fn === "increase_allowance") {
    return `${owner} increased ${spenderFmt}'s allowance by ${amount ?? "?"} ${tokenLabel}`;
  }
  if (fn === "decrease_allowance") {
    return `${owner} decreased ${spenderFmt}'s allowance by ${amount ?? "?"} ${tokenLabel}`;
  }

  // approve / set_allowance
  const isRevoke =
    amount === 0 ||
    amount === 0n ||
    amount === "0" ||
    (amount != null && Number(amount) === 0);

  if (isRevoke) {
    return `${owner} revoked ${spenderFmt}'s allowance to spend ${tokenLabel}`;
  }

  const expiry =
    !expirationLedger || expirationLedger === 0 || expirationLedger === 0n
      ? "no expiry"
      : `expires ledger #${expirationLedger}`;

  return `${owner} approved ${spenderFmt} to spend up to ${amount} ${tokenLabel} (${expiry})`;
}

// ── NFT helpers (issue #562) ──────────────────────────────────────────────────

/**
 * Produces human-readable descriptions for NFT events.
 *
 * transfer (NFT):  "GA… transferred NFT #1234 (collection: Stellar Punks) to GB…"
 * mint_nft:        "GA… minted NFT #1234 from collection CTEST… at ledger #N"
 * burn_nft:        "GA… burned NFT #1234"
 * create:          "GA… created NFT #1234 on COLLECTION"
 * list_nft:        "GA… listed NFT #1234 for AMOUNT on COLLECTION"
 *
 * Arg order heuristic:
 *   transfer(from, to, token_id, collection?)
 *   mint_nft(to, token_id, ledger?, collection?)
 *   burn_nft(from, token_id)
 *   create(from, token_id, collection?)
 *   list_nft(from, token_id, amount?, collection?)
 */
function buildNftDescription(fn, args, _data, contractName) {
  // Helper to locate a token_id: a u64-range integer / bigint that is NOT a
  // Stellar address (addresses are 56-char strings starting with G/C).
  const findTokenId = (arr) =>
    arr.find(
      (a) =>
        (typeof a === "bigint" && a >= 0n) ||
        (typeof a === "number" && Number.isInteger(a) && a >= 0 && a < Number.MAX_SAFE_INTEGER)
    );

  switch (fn) {
    case "transfer": {
      const [from, to] = args;
      const tokenId = findTokenId(args.slice(2)) ?? findTokenId(args);
      const collection = args.find((a) => typeof a === "string" && a.length > 10 && a !== from && a !== to);
      const collectionStr = collection ? ` (collection: ${collection})` : "";
      return `${fmt(from)} transferred NFT #${tokenId ?? "?"}${collectionStr} to ${fmt(to)}`;
    }
    case "mint_nft": {
      const [to] = args;
      const tokenId = findTokenId(args.slice(1));
      const ledger = args.find((a) => typeof a === "number" && a > 1_000_000);
      const collection = args.find(
        (a) => typeof a === "string" && a.length > 10 && a !== to && a !== String(ledger)
      );
      const ledgerStr = ledger ? ` at ledger #${ledger}` : "";
      const collStr = collection ? ` from collection ${fmt(collection)}` : ` on ${contractName}`;
      return `${fmt(to)} minted NFT #${tokenId ?? "?"}${collStr}${ledgerStr}`;
    }
    case "burn_nft": {
      const [from] = args;
      const tokenId = findTokenId(args.slice(1));
      return `${fmt(from)} burned NFT #${tokenId ?? "?"}`;
    }
    case "create": {
      const [from] = args;
      const tokenId = findTokenId(args.slice(1));
      return `${fmt(from)} created NFT #${tokenId ?? "?"} on ${contractName}`;
    }
    case "list_nft": {
      const [from] = args;
      const tokenId = findTokenId(args.slice(1));
      const amount = args.find((a) => (typeof a === "bigint" || typeof a === "number") && a !== tokenId);
      const amtStr = amount != null ? ` for ${amount}` : "";
      return `${fmt(from)} listed NFT #${tokenId ?? "?"}${amtStr} on ${contractName}`;
    }
    default:
      return genericDescription(fn, args, _data, contractName);
  }
}

// ── AMM liquidity helpers (issue #563) ───────────────────────────────────────

/**
 * Produces human-readable descriptions for AMM liquidity events.
 *
 * add_liquidity / provide_liquidity:
 *   "GA… added 100 XLM + 50 USDC to XLM/USDC pool (received 70.7 LP tokens)"
 *   (LP token portion omitted if not present in the event)
 *
 * remove_liquidity / withdraw_liquidity:
 *   "GA… removed 70.7 LP tokens from XLM/USDC pool (received 100 XLM + 49.8 USDC)"
 *
 * Arg order heuristic (AMM events are not standardised, so we detect by type):
 *   provide: (from, token_a, amount_a, token_b, amount_b, lp_amount?)
 *   remove:  (from, lp_amount, token_a, amount_a, token_b, amount_b)
 */
function buildLiquidityDescription(fn, args, _data, contractName) {
  const isAdd = fn === "add_liquidity" || fn === "provide_liquidity";

  // Find the provider address (first G/C address)
  const from = args.find((a) => typeof a === "string" && (a.startsWith("G") || a.startsWith("C")));

  // Collect all string tokens and numeric amounts in order
  const tokens = args.filter(
    (a) => typeof a === "string" && a !== from && a.length >= 3 && a.length <= 12
  );
  const amounts = args.filter(
    (a) => (typeof a === "bigint" && a >= 0n) || (typeof a === "number" && a >= 0)
  );

  const tokenA = tokens[0] ?? "token_a";
  const tokenB = tokens[1] ?? "token_b";
  const amountA = amounts[0] ?? "?";
  const amountB = amounts[1] ?? "?";
  const lpAmount = amounts[2]; // optional third amount = LP tokens

  const poolLabel = `${tokenA}/${tokenB} pool`;
  const provider = fmt(from);

  if (isAdd) {
    const lpStr = lpAmount != null ? ` (received ${lpAmount} LP tokens)` : "";
    return `${provider} added ${amountA} ${tokenA} + ${amountB} ${tokenB} to ${poolLabel}${lpStr}`;
  }

  // remove / withdraw: LP tokens are the first amount, received tokens follow
  const lpAmt = amounts[0] ?? "?";
  const recvA = amounts[1] ?? "?";
  const recvB = amounts[2] ?? "?";
  return `${provider} removed ${lpAmt} LP tokens from ${poolLabel} (received ${recvA} ${tokenA} + ${recvB} ${tokenB})`;
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

// ── Batch decoder (issue #564) ────────────────────────────────────────────────

/**
 * Given an array of decoded event objects that share the same tx_hash, produce
 * an aggregate human-readable description for the batch.
 *
 * Rules:
 *  • Single-event arrays → returns null (caller leaves batch_description NULL)
 *  • Two events          → "GA… {verb1} then {verb2} in one transaction"
 *  • Three or more       → "GA… performed {n} operations in one transaction:
 *                           {verb1}; {verb2}; …"
 *
 * The "from" address is taken from the first event whose description starts
 * with a recognisable address pattern (GAAA…).
 *
 * @param {Array<{description: string, function: string}>} events
 *   Decoded events sorted by sequence / topic order within the transaction.
 * @returns {string|null}  Aggregate description, or null for single-event txs.
 */
export function batchDescription(events) {
  if (!Array.isArray(events) || events.length <= 1) return null;

  // Extract a short verb from each event description.
  // e.g. "GAAAAA…AAAA approved …" → "approved …" (strip leading address token)
  const verbs = events.map((ev) => {
    const desc = ev.description ?? ev.function ?? "unknown operation";
    // Strip a leading "Address GAAA…ZZZZ " or "GAAA…ZZZZ " prefix
    return desc.replace(/^(Address\s+)?[GC][A-Z0-9]{5}…[A-Z0-9]{4}\s+/, "").trim();
  });

  // Try to extract the initiating address from the first event
  const addrMatch = (events[0].description ?? "").match(/([GC][A-Z0-9]{5}…[A-Z0-9]{4})/);
  const actor = addrMatch ? addrMatch[1] : "An address";

  if (events.length === 2) {
    return `${actor} ${verbs[0]} then ${verbs[1]} in one transaction`;
  }

  const verbList = verbs.join("; ");
  return `${actor} performed ${events.length} operations in one transaction: ${verbList}`;
}
