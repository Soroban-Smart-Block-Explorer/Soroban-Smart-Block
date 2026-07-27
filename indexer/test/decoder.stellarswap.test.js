/**
 * Unit tests: decoder.js StellarSwap DEX handler (issue #552).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stellarSwapDescription } from "../src/decoder.js";

const TRADER = "G" + "A".repeat(55);
const TRADER_SHORT = "GAAAAA…AAAA";
const LEDGER = 123456;

describe("decoder — StellarSwap swap (issue #552)", () => {
  it("swap decodes token codes, amounts, slippage, and ledger", () => {
    const desc = stellarSwapDescription("swap", [TRADER, "USDC", "XLM"], [100, 98.7, 100], LEDGER);
    assert.ok(desc.includes(TRADER_SHORT), `missing trader in "${desc}"`);
    assert.ok(desc.includes("100 USDC"), `missing amount_in/token_in in "${desc}"`);
    assert.ok(desc.includes("98.7 XLM"), `missing amount_out/token_out in "${desc}"`);
    assert.ok(desc.includes("slippage 1.3%"), `missing slippage in "${desc}"`);
    assert.ok(desc.includes("on StellarSwap"), `missing DEX label in "${desc}"`);
    assert.ok(desc.includes(`ledger #${LEDGER}`), `missing ledger in "${desc}"`);
  });

  it("swap_exact_tokens_for_tokens uses the same formatter", () => {
    const desc = stellarSwapDescription("swap_exact_tokens_for_tokens", [TRADER, "USDC", "XLM"], [100, 98.7, 100], LEDGER);
    assert.ok(desc.includes("100 USDC"));
    assert.ok(desc.includes("98.7 XLM"));
  });

  it("omits the slippage clause when no expected amount is present", () => {
    const desc = stellarSwapDescription("swap", [TRADER, "USDC", "XLM"], [100, 98.7], LEDGER);
    assert.ok(!desc.includes("slippage"), `unexpected slippage clause in "${desc}"`);
  });

  it("returns null for an unrelated function name", () => {
    assert.equal(stellarSwapDescription("unknown_fn", [], [], LEDGER), null);
  });

  it("delegates add_liquidity/remove_liquidity to the shared AMM liquidity formatter", () => {
    const desc = stellarSwapDescription(
      "add_liquidity",
      [TRADER, "USDC", 100n, "XLM", 500n],
      [],
      LEDGER,
    );
    assert.ok(desc.includes("added"), `expected liquidity description in "${desc}"`);
    assert.ok(desc.includes("USDC"));
    assert.ok(desc.includes("XLM"));
  });
});
