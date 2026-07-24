/**
 * Unit tests for sac.js SAC detection and native XLM wrap/unwrap descriptions.
 * Closes #419
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Asset, Contract, Networks } from "@stellar/stellar-sdk";
import { detectSac, detectSacAsset, sacLabel } from "../src/sac.js";
import { nativeXlmDescription } from "../src/decoder.js";

// Derive the native XLM SAC contract ID for testnet (matches the default NETWORK_PASSPHRASE)
const NATIVE_SAC_ID = new Contract(
  Asset.native().contractId(Networks.TESTNET)
).contractId();

// Arbitrary Stellar account address (56 chars, G-prefix)
const USER_ADDR = "G" + "A".repeat(55);

// ── SAC detection ─────────────────────────────────────────────────────────────

describe("detectSac — native XLM", () => {
  it("recognises the native XLM SAC contract ID", () => {
    const { isSac, assetCode } = detectSac(NATIVE_SAC_ID);
    assert.equal(isSac, true);
    assert.equal(assetCode, "XLM");
  });

  it("returns isSac: false for an unknown contract", () => {
    const { isSac } = detectSac("C" + "B".repeat(55));
    assert.equal(isSac, false);
  });
});

describe("detectSacAsset — native XLM", () => {
  it("returns assetCode XLM and null issuer for native SAC", () => {
    const result = detectSacAsset(NATIVE_SAC_ID);
    assert.equal(result.isSac, true);
    assert.equal(result.assetCode, "XLM");
    assert.equal(result.assetIssuer, null);
  });
});

describe("sacLabel — native XLM", () => {
  it("returns XLM for native SAC contract ID", () => {
    assert.equal(sacLabel(NATIVE_SAC_ID), "XLM");
  });

  it("falls back to the contract ID for unknown contracts", () => {
    const unknown = "C" + "Z".repeat(55);
    assert.equal(sacLabel(unknown), unknown);
  });
});

// ── Native XLM wrap / unwrap descriptions ────────────────────────────────────
// nativeXlmDescription() in decoder.js is invoked when the SAC contract ID is
// the native XLM SAC and the function name is "mint" (wrap) or "burn" (unwrap).

describe("nativeXlmDescription — wrap (mint on native SAC)", () => {
  // 10_000_000 stroops = 1 XLM
  const AMOUNT = 10_000_000;

  it("produces a description that contains XLM", () => {
    const result = nativeXlmDescription("mint", [USER_ADDR, AMOUNT], null);
    assert.ok(result !== null);
    assert.ok(result.description.includes("XLM"), `expected XLM in "${result.description}"`);
  });

  it("produces a description that contains the formatted amount", () => {
    const result = nativeXlmDescription("mint", [USER_ADDR, AMOUNT], null);
    // 10_000_000 stroops → "1" XLM (fmtXlm divides by 1e7)
    assert.ok(result.description.includes("1"), `expected amount "1" in "${result.description}"`);
  });

  it("sets function to wrap_native", () => {
    const result = nativeXlmDescription("mint", [USER_ADDR, AMOUNT], null);
    assert.equal(result.function, "wrap_native");
  });

  it("description mentions Classic → Soroban direction", () => {
    const result = nativeXlmDescription("mint", [USER_ADDR, AMOUNT], null);
    assert.ok(result.description.includes("Classic"), `expected "Classic" in "${result.description}"`);
    assert.ok(result.description.includes("Soroban"), `expected "Soroban" in "${result.description}"`);
  });
});

describe("nativeXlmDescription — unwrap (burn on native SAC)", () => {
  const AMOUNT = 50_000_000; // 5 XLM

  it("produces a description that contains XLM", () => {
    const result = nativeXlmDescription("burn", [USER_ADDR, AMOUNT], null);
    assert.ok(result !== null);
    assert.ok(result.description.includes("XLM"), `expected XLM in "${result.description}"`);
  });

  it("produces a description that contains the formatted amount", () => {
    const result = nativeXlmDescription("burn", [USER_ADDR, AMOUNT], null);
    // 50_000_000 stroops → "5" XLM
    assert.ok(result.description.includes("5"), `expected amount "5" in "${result.description}"`);
  });

  it("sets function to unwrap_native", () => {
    const result = nativeXlmDescription("burn", [USER_ADDR, AMOUNT], null);
    assert.equal(result.function, "unwrap_native");
  });

  it("description mentions Soroban → Classic direction", () => {
    const result = nativeXlmDescription("burn", [USER_ADDR, AMOUNT], null);
    assert.ok(result.description.includes("Soroban"), `expected "Soroban" in "${result.description}"`);
    assert.ok(result.description.includes("Classic"), `expected "Classic" in "${result.description}"`);
  });

  it("returns null for non-wrap/unwrap function names", () => {
    assert.equal(nativeXlmDescription("transfer", [USER_ADDR, AMOUNT], null), null);
    assert.equal(nativeXlmDescription("approve", [], null), null);
  });
});
