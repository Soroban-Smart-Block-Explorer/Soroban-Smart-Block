/**
 * CAP-0080 Protocol 26 ZK host function telemetry.
 *
 * Detects BN254 and BLS12-381 host function calls from the Soroban execution
 * trace and computes a cost delta showing how much cheaper the native
 * implementation is versus equivalent Wasm-side micro-allocations.
 *
 * Host function names follow the CAP-0080 naming convention:
 *   bn254_g1_msm, bn254_g2_msm, bn254_pairing_check,
 *   bn254_fr_add, bn254_fr_mul, bn254_fr_inv,
 *   bls12_381_g1_msm, bls12_381_g2_msm, bls12_381_pairing_check,
 *   bls12_381_fr_add, bls12_381_fr_mul, bls12_381_fr_inv,
 *   bls12_381_map_fp_to_g1, bls12_381_map_fp2_to_g2,
 *   bls12_381_hash_to_g1, bls12_381_hash_to_g2
 */

// CAP-0080 native host function names (Protocol 26+)
const ZK_HOST_FN_NAMES = new Set([
  // BN254
  "bn254_g1_msm",
  "bn254_g2_msm",
  "bn254_pairing_check",
  "bn254_fr_add",
  "bn254_fr_mul",
  "bn254_fr_inv",
  // BLS12-381
  "bls12_381_g1_msm",
  "bls12_381_g2_msm",
  "bls12_381_pairing_check",
  "bls12_381_fr_add",
  "bls12_381_fr_mul",
  "bls12_381_fr_inv",
  "bls12_381_map_fp_to_g1",
  "bls12_381_map_fp2_to_g2",
  "bls12_381_hash_to_g1",
  "bls12_381_hash_to_g2",
]);

/**
 * Estimated Wasm-side CPU instruction cost for each operation if implemented
 * without native host functions (based on CAP-0080 cost model benchmarks).
 * Units: CPU instructions (same unit as sorobanMeta resource usage).
 */
const LEGACY_WASM_COST = {
  // BN254
  bn254_g1_msm: 2_500_000,
  bn254_g2_msm: 5_000_000,
  bn254_pairing_check: 8_000_000,
  bn254_fr_add: 10_000,
  bn254_fr_mul: 50_000,
  bn254_fr_inv: 200_000,
  // BLS12-381
  bls12_381_g1_msm: 4_000_000,
  bls12_381_g2_msm: 8_000_000,
  bls12_381_pairing_check: 12_000_000,
  bls12_381_fr_add: 15_000,
  bls12_381_fr_mul: 80_000,
  bls12_381_fr_inv: 300_000,
  bls12_381_map_fp_to_g1: 500_000,
  bls12_381_map_fp2_to_g2: 900_000,
  bls12_381_hash_to_g1: 1_200_000,
  bls12_381_hash_to_g2: 2_000_000,
};

/**
 * Native host function CPU cost (Protocol 26 metered cost from CAP-0080).
 */
const NATIVE_HOST_COST = {
  bn254_g1_msm: 150_000,
  bn254_g2_msm: 300_000,
  bn254_pairing_check: 500_000,
  bn254_fr_add: 1_000,
  bn254_fr_mul: 3_000,
  bn254_fr_inv: 12_000,
  bls12_381_g1_msm: 250_000,
  bls12_381_g2_msm: 500_000,
  bls12_381_pairing_check: 800_000,
  bls12_381_fr_add: 1_500,
  bls12_381_fr_mul: 5_000,
  bls12_381_fr_inv: 18_000,
  bls12_381_map_fp_to_g1: 30_000,
  bls12_381_map_fp2_to_g2: 55_000,
  bls12_381_hash_to_g1: 80_000,
  bls12_381_hash_to_g2: 130_000,
};

/**
 * Extract ZK host function calls from a Soroban RPC event's execution trace.
 *
 * The Soroban RPC may surface host function invocations in several places:
 *   - ev.diagnosticEvents[].event.body.v0.data  (diagnostic trace)
 *   - ev.hostFunctions[]                         (direct list, future RPC)
 *   - ev.txMeta.v3().sorobanMeta().diagnosticEvents()  (XDR path)
 *
 * We scan all available sources and collect every ZK host function call.
 *
 * @param {object} ev  Raw Soroban RPC event
 * @returns {ZkHostCall[] | null}  null when no ZK calls detected
 */
export function parseZkHostFunctions(ev) {
  const calls = [];

  // Source 1: diagnosticEvents array (JSON-decoded by the RPC client)
  const diagEvents = ev.diagnosticEvents ?? ev.diagnostic_events ?? [];
  for (const de of diagEvents) {
    const fnName = extractDiagFnName(de);
    if (fnName && ZK_HOST_FN_NAMES.has(fnName)) {
      calls.push(buildCall(fnName, de));
    }
  }

  // Source 2: flat hostFunctions list (some RPC versions)
  const hostFns = ev.hostFunctions ?? ev.host_functions ?? [];
  for (const hf of hostFns) {
    const fnName = typeof hf === "string" ? hf : (hf.name ?? hf.fn_name ?? null);
    if (fnName && ZK_HOST_FN_NAMES.has(fnName)) {
      calls.push(buildCall(fnName, hf));
    }
  }

  // Source 3: XDR sorobanMeta diagnosticEvents
  try {
    const sorobanMeta = ev.txMeta?.v3?.()?.sorobanMeta?.();
    const xdrDiag = sorobanMeta?.diagnosticEvents?.() ?? [];
    for (const de of xdrDiag) {
      const fnName = extractXdrDiagFnName(de);
      if (fnName && ZK_HOST_FN_NAMES.has(fnName)) {
        calls.push(buildCall(fnName, de));
      }
    }
  } catch {
    /* XDR not available */
  }

  if (calls.length === 0) return null;

  // Deduplicate by fn_name+index to avoid double-counting across sources
  const seen = new Set();
  const unique = calls.filter((c) => {
    const key = `${c.fn_name}:${c.cpu_native}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return unique;
}

/**
 * High-level ZK detection for the EventPage cost panel (CAP-0080).
 *
 * Given a transaction meta (XDR `TransactionMeta` object) — or an event-like
 * wrapper already carrying `txMeta` / `diagnosticEvents` / `hostFunctions` —
 * returns a flat result describing whether the transaction invoked any native
 * ZK host function and, if so, the aggregate cost delta versus a Wasm-side
 * implementation.
 *
 * @param {object} txMeta  Stellar `TransactionMeta` XDR object, or event-like wrapper
 * @returns {{ is_zk: boolean, calls: ZkHostCall[], total_native: number, total_legacy: number, saved_cpu: number, saved_pct: number }}
 */
export function detect(txMeta) {
  // Accept either a raw txMeta XDR object or an event-like wrapper. The parser
  // looks for ZK calls under ev.txMeta / ev.diagnosticEvents / ev.hostFunctions,
  // so wrap a bare txMeta accordingly.
  const ev =
    txMeta &&
    (txMeta.txMeta || txMeta.diagnosticEvents || txMeta.diagnostic_events ||
      txMeta.hostFunctions || txMeta.host_functions)
      ? txMeta
      : { txMeta };

  const calls = parseZkHostFunctions(ev);
  if (!calls || calls.length === 0) {
    return {
      is_zk: false,
      calls: [],
      total_native: 0,
      total_legacy: 0,
      saved_cpu: 0,
      saved_pct: 0,
    };
  }

  return { is_zk: true, calls, ...computeZkCostDelta(calls) };
}

/**
 * Compute aggregate cost delta across all ZK calls in an event.
 *
 * @param {ZkHostCall[]} calls
 * @returns {{ total_native: number, total_legacy: number, saved_cpu: number, saved_pct: number }}
 */
export function computeZkCostDelta(calls) {
  let total_native = 0;
  let total_legacy = 0;
  for (const c of calls) {
    total_native += c.cpu_native;
    total_legacy += c.cpu_legacy;
  }
  const saved_cpu = total_legacy - total_native;
  const saved_pct = total_legacy > 0 ? Math.round((saved_cpu / total_legacy) * 100) : 0;
  return { total_native, total_legacy, saved_cpu, saved_pct };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildCall(fnName, _source) {
  const cpu_native = NATIVE_HOST_COST[fnName] ?? 0;
  const cpu_legacy = LEGACY_WASM_COST[fnName] ?? 0;
  const curve = fnName.startsWith("bn254") ? "BN254" : "BLS12-381";
  const kind = fnName.includes("msm")
    ? "msm"
    : fnName.includes("pairing")
      ? "pairing"
      : fnName.includes("fr_")
        ? "scalar_field"
        : fnName.includes("map_")
          ? "map_to_curve"
          : fnName.includes("hash_")
            ? "hash_to_curve"
            : "other";

  return { fn_name: fnName, curve, kind, cpu_native, cpu_legacy };
}

function extractDiagFnName(de) {
  // JSON diagnostic event: { event: { body: { v0: { data: { sym: "fn_name" } } } } }
  try {
    const sym =
      de?.event?.body?.v0?.data?.sym ??
      de?.event?.body?.v0?.data?.[0] ??
      de?.body?.v0?.data?.sym ??
      de?.fn_name ??
      de?.name ??
      null;
    return typeof sym === "string" ? sym : null;
  } catch {
    return null;
  }
}

function extractXdrDiagFnName(de) {
  try {
    const data = de?.event?.()?.body?.()?.v0?.()?.data?.();
    if (!data) return null;
    // ScVal sym
    const sym = data.sym?.() ?? data.value?.sym?.() ?? null;
    return typeof sym === "string" ? sym : null;
  } catch {
    return null;
  }
}

/**
 * @typedef {{ fn_name: string, curve: string, kind: string, cpu_native: number, cpu_legacy: number }} ZkHostCall
 */
