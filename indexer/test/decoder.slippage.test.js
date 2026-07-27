/**
 * Unit tests: decoder.js swap slippage annotation and slippage_bps computation.
 * Closes #554
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildDescription, computeSlippageBps, extractSwapSlippageBps } from "../src/decoder.js";

const ADDR = "G" + "A".repeat(55);
const CONTRACT = "StellarSwap";

describe("decoder — swap slippage annotation", () => {
  it("a swap with 1% slippage shows (slippage: 1.00%)", () => {
    // amount_out=99, min_amount_out=100 → |99-100|/100 = 1%
    const desc = buildDescription("swap", [ADDR, 100, "USDC", 99, "XLM", 100], null, CONTRACT);
    assert.ok(desc.includes("(slippage: 1.00%)"), `expected "(slippage: 1.00%)" in "${desc}"`);
  });

  it("a swap with 0.05% slippage does not show a slippage annotation", () => {
    // amount_out=99.95, min_amount_out=100 → |99.95-100|/100 = 0.05%
    const desc = buildDescription("swap", [ADDR, 100, "USDC", 99.95, "XLM", 100], null, CONTRACT);
    assert.ok(!desc.includes("slippage"), `expected no slippage annotation in "${desc}"`);
  });

  it("exactly 0.1% slippage does not show an annotation (threshold is exclusive)", () => {
    // amount_out=99.9, min_amount_out=100 → |99.9-100|/100 = 0.1%
    const desc = buildDescription("swap", [ADDR, 100, "USDC", 99.9, "XLM", 100], null, CONTRACT);
    assert.ok(!desc.includes("slippage"), `expected no slippage annotation in "${desc}"`);
  });

  it("omits the annotation entirely when min_amount_out is not present", () => {
    const desc = buildDescription("swap", [ADDR, 100, "USDC", 99, "XLM"], null, CONTRACT);
    assert.ok(!desc.includes("slippage"), `expected no slippage annotation in "${desc}"`);
  });

  it("applies the same slippage logic to swap_exact_tokens_for_tokens", () => {
    const desc = buildDescription(
      "swap_exact_tokens_for_tokens",
      [ADDR, 100, "USDC", 95, "XLM", 100],
      null,
      CONTRACT,
    );
    assert.ok(desc.includes("(slippage: 5.00%)"), `expected "(slippage: 5.00%)" in "${desc}"`);
  });
});

describe("decoder — computeSlippageBps", () => {
  it("returns basis points for a valid amount pair", () => {
    assert.equal(computeSlippageBps(99, 100), 100); // 1% = 100 bps
  });

  it("returns null when min_amount_out is zero", () => {
    assert.equal(computeSlippageBps(99, 0), null);
  });

  it("returns null when either amount is missing", () => {
    assert.equal(computeSlippageBps(99, null), null);
    assert.equal(computeSlippageBps(null, 100), null);
  });
});

describe("decoder — extractSwapSlippageBps", () => {
  it("reads amount_out (index 3) and min_amount_out (index 5) from swap args", () => {
    const bps = extractSwapSlippageBps([ADDR, 100, "USDC", 99, "XLM", 100]);
    assert.equal(bps, 100);
  });

  it("returns null for a short args array without min_amount_out", () => {
    const bps = extractSwapSlippageBps([ADDR, 100, "USDC", 99, "XLM"]);
    assert.equal(bps, null);
  });
});
