/**
 * Issue #164 — Tests for zkHostFunctions.js (CAP-0080)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseZkHostFunctions, computeZkCostDelta, detect } from "../src/zkHostFunctions.js";

// ── parseZkHostFunctions ──────────────────────────────────────────────────────

describe("parseZkHostFunctions", () => {
  it("returns null when no ZK calls present", () => {
    assert.equal(parseZkHostFunctions({}), null);
    assert.equal(parseZkHostFunctions({ diagnosticEvents: [] }), null);
    assert.equal(parseZkHostFunctions({ hostFunctions: ["transfer", "mint"] }), null);
  });

  it("detects BN254 MSM from diagnosticEvents JSON path", () => {
    const ev = {
      diagnosticEvents: [
        { event: { body: { v0: { data: { sym: "bn254_g1_msm" } } } } },
      ],
    };
    const calls = parseZkHostFunctions(ev);
    assert.ok(calls);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].fn_name, "bn254_g1_msm");
    assert.equal(calls[0].curve, "BN254");
    assert.equal(calls[0].kind, "msm");
  });

  it("detects BLS12-381 pairing from diagnosticEvents", () => {
    const ev = {
      diagnosticEvents: [
        { event: { body: { v0: { data: { sym: "bls12_381_pairing_check" } } } } },
      ],
    };
    const calls = parseZkHostFunctions(ev);
    assert.ok(calls);
    assert.equal(calls[0].fn_name, "bls12_381_pairing_check");
    assert.equal(calls[0].curve, "BLS12-381");
    assert.equal(calls[0].kind, "pairing");
  });

  it("detects ZK calls from flat hostFunctions string array", () => {
    const ev = { hostFunctions: ["bn254_fr_add", "bn254_fr_mul"] };
    const calls = parseZkHostFunctions(ev);
    assert.ok(calls);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].kind, "scalar_field");
    assert.equal(calls[1].kind, "scalar_field");
  });

  it("detects ZK calls from flat hostFunctions object array", () => {
    const ev = { hostFunctions: [{ name: "bls12_381_fr_inv" }] };
    const calls = parseZkHostFunctions(ev);
    assert.ok(calls);
    assert.equal(calls[0].fn_name, "bls12_381_fr_inv");
  });

  it("detects map_to_curve and hash_to_curve kinds", () => {
    const ev = {
      hostFunctions: ["bls12_381_map_fp_to_g1", "bls12_381_hash_to_g2"],
    };
    const calls = parseZkHostFunctions(ev);
    assert.ok(calls);
    assert.equal(calls[0].kind, "map_to_curve");
    assert.equal(calls[1].kind, "hash_to_curve");
  });

  it("deduplicates identical calls across sources", () => {
    const ev = {
      diagnosticEvents: [
        { event: { body: { v0: { data: { sym: "bn254_g1_msm" } } } } },
      ],
      hostFunctions: ["bn254_g1_msm"],
    };
    const calls = parseZkHostFunctions(ev);
    assert.ok(calls);
    assert.equal(calls.length, 1);
  });

  it("ignores non-ZK host functions in diagnosticEvents", () => {
    const ev = {
      diagnosticEvents: [
        { event: { body: { v0: { data: { sym: "transfer" } } } } },
        { event: { body: { v0: { data: { sym: "bn254_fr_inv" } } } } },
      ],
    };
    const calls = parseZkHostFunctions(ev);
    assert.ok(calls);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].fn_name, "bn254_fr_inv");
  });

  it("populates cpu_native and cpu_legacy for each call", () => {
    const ev = { hostFunctions: ["bn254_g1_msm"] };
    const calls = parseZkHostFunctions(ev);
    assert.ok(calls);
    assert.ok(calls[0].cpu_native > 0);
    assert.ok(calls[0].cpu_legacy > 0);
    assert.ok(calls[0].cpu_legacy > calls[0].cpu_native, "legacy should cost more than native");
  });

  it("handles malformed diagnosticEvent entries gracefully", () => {
    const ev = {
      diagnosticEvents: [null, undefined, {}, { event: null }],
    };
    assert.equal(parseZkHostFunctions(ev), null);
  });
});

// ── detect (issue #422) ───────────────────────────────────────────────────────

// Build a txMeta whose accessor-method shape mirrors the @stellar/stellar-sdk
// `TransactionMeta` XDR object the parser's Source 3 path consumes:
//   txMeta.v3().sorobanMeta().diagnosticEvents()[i].event().body().v0().data().sym()
function mockTxMeta(fnNames) {
  const diagnosticEvents = fnNames.map((fnName) => ({
    event: () => ({
      body: () => ({
        v0: () => ({
          data: () => ({ sym: () => fnName }),
        }),
      }),
    }),
  }));
  return {
    v3: () => ({
      sorobanMeta: () => ({
        diagnosticEvents: () => diagnosticEvents,
      }),
    }),
  };
}

describe("detect", () => {
  it("returns is_zk: true with populated cost fields for a ZK txMeta XDR", () => {
    const result = detect(mockTxMeta(["bls12_381_pairing_check"]));
    assert.equal(result.is_zk, true);
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0].fn_name, "bls12_381_pairing_check");
    assert.ok(result.total_native > 0);
    assert.ok(result.total_legacy > 0);
    assert.ok(result.saved_cpu > 0);
    assert.ok(result.saved_pct > 0);
    assert.equal(result.total_legacy - result.total_native, result.saved_cpu);
  });

  it("aggregates cost across multiple ZK calls in one txMeta", () => {
    const result = detect(mockTxMeta(["bn254_g1_msm", "bn254_pairing_check"]));
    assert.equal(result.is_zk, true);
    assert.equal(result.calls.length, 2);
    assert.ok(result.saved_cpu > 0);
  });

  it("returns is_zk: false for a non-ZK txMeta XDR", () => {
    const result = detect(mockTxMeta(["transfer", "mint"]));
    assert.equal(result.is_zk, false);
    assert.deepEqual(result.calls, []);
    assert.equal(result.total_native, 0);
    assert.equal(result.total_legacy, 0);
    assert.equal(result.saved_cpu, 0);
    assert.equal(result.saved_pct, 0);
  });

  it("returns is_zk: false for empty / missing txMeta", () => {
    assert.equal(detect(mockTxMeta([])).is_zk, false);
    assert.equal(detect(undefined).is_zk, false);
    assert.equal(detect({}).is_zk, false);
  });

  it("also accepts an event-like wrapper carrying hostFunctions", () => {
    const result = detect({ hostFunctions: ["bn254_fr_mul"] });
    assert.equal(result.is_zk, true);
    assert.equal(result.calls[0].fn_name, "bn254_fr_mul");
  });
});

// ── computeZkCostDelta ────────────────────────────────────────────────────────

describe("computeZkCostDelta", () => {
  it("sums native and legacy costs across all calls", () => {
    const calls = [
      { fn_name: "bn254_g1_msm", curve: "BN254", kind: "msm", cpu_native: 150_000, cpu_legacy: 2_500_000 },
      { fn_name: "bn254_fr_add", curve: "BN254", kind: "scalar_field", cpu_native: 1_000, cpu_legacy: 10_000 },
    ];
    const delta = computeZkCostDelta(calls);
    assert.equal(delta.total_native, 151_000);
    assert.equal(delta.total_legacy, 2_510_000);
    assert.equal(delta.saved_cpu, 2_359_000);
  });

  it("computes saved_pct correctly", () => {
    const calls = [
      { fn_name: "bn254_fr_mul", curve: "BN254", kind: "scalar_field", cpu_native: 25_000, cpu_legacy: 50_000 },
    ];
    const delta = computeZkCostDelta(calls);
    assert.equal(delta.saved_pct, 50);
  });

  it("returns 0 saved_pct when legacy cost is 0", () => {
    const calls = [
      { fn_name: "unknown", curve: "BN254", kind: "other", cpu_native: 0, cpu_legacy: 0 },
    ];
    const delta = computeZkCostDelta(calls);
    assert.equal(delta.saved_pct, 0);
  });

  it("handles empty calls array", () => {
    const delta = computeZkCostDelta([]);
    assert.equal(delta.total_native, 0);
    assert.equal(delta.total_legacy, 0);
    assert.equal(delta.saved_cpu, 0);
    assert.equal(delta.saved_pct, 0);
  });

  it("native cost is always less than legacy for all known ops", () => {
    const ev = {
      hostFunctions: [
        "bn254_g1_msm", "bn254_g2_msm", "bn254_pairing_check",
        "bn254_fr_add", "bn254_fr_mul", "bn254_fr_inv",
        "bls12_381_g1_msm", "bls12_381_g2_msm", "bls12_381_pairing_check",
        "bls12_381_fr_add", "bls12_381_fr_mul", "bls12_381_fr_inv",
        "bls12_381_map_fp_to_g1", "bls12_381_map_fp2_to_g2",
        "bls12_381_hash_to_g1", "bls12_381_hash_to_g2",
      ],
    };
    const calls = parseZkHostFunctions(ev);
    assert.ok(calls);
    const delta = computeZkCostDelta(calls);
    assert.ok(delta.total_native < delta.total_legacy, "native total must be cheaper than legacy");
    assert.ok(delta.saved_pct > 0);
  });
});
