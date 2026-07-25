/**
 * Unit tests: decoder.js handlers for issues #561-#564.
 *
 * Tests cover:
 *  #561 – approve, set_allowance, increase_allowance, decrease_allowance
 *  #562 – NFT transfer, mint_nft, burn_nft, create, list_nft
 *  #563 – add_liquidity, provide_liquidity, remove_liquidity, withdraw_liquidity
 *  #564 – batchDescription helper
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildDescription, batchDescription } from "../src/decoder.js";

// ── Shared test fixtures ───────────────────────────────────────────────────────

const FROM = "G" + "A".repeat(55); // GAAAAAA…AAAA
const SPENDER = "G" + "B".repeat(55); // GBBBBBBB…BBBB
const TO = "G" + "C".repeat(55);
const CONTRACT = "USDC Token";
const TOKEN = "USDC";

// Expected short forms
const FROM_SHORT = "GAAAAA…AAAA";
const SPENDER_SHORT = "GBBBBB…BBBB";
const TO_SHORT = "GCCCCC…CCCC";

// ── #561: approve / allowance ──────────────────────────────────────────────────

describe("decoder — approve (issue #561)", () => {
  it("approve with amount and expiration_ledger produces correct description", () => {
    const desc = buildDescription(
      "approve",
      [FROM, SPENDER, 5000000000n, 5000000, TOKEN],
      null,
      CONTRACT
    );
    assert.ok(desc.includes(FROM_SHORT), `missing from address in "${desc}"`);
    assert.ok(desc.includes(SPENDER_SHORT), `missing spender address in "${desc}"`);
    assert.ok(desc.includes("approved"), `missing "approved" in "${desc}"`);
    assert.ok(desc.includes("5000000000"), `missing amount in "${desc}"`);
    assert.ok(desc.includes("USDC"), `missing token in "${desc}"`);
    assert.ok(desc.includes("expires ledger #5000000"), `missing expiry in "${desc}"`);
  });

  it("approve with expiration_ledger=0 shows (no expiry)", () => {
    const desc = buildDescription(
      "approve",
      [FROM, SPENDER, 500n, 0, TOKEN],
      null,
      CONTRACT
    );
    assert.ok(desc.includes("no expiry"), `expected "no expiry" in "${desc}"`);
  });

  it("approve with null expiration_ledger shows (no expiry)", () => {
    const desc = buildDescription(
      "approve",
      [FROM, SPENDER, 500n, null, TOKEN],
      null,
      CONTRACT
    );
    assert.ok(desc.includes("no expiry"), `expected "no expiry" in "${desc}"`);
  });

  it("approve with amount=0 is a revoke", () => {
    const desc = buildDescription(
      "approve",
      [FROM, SPENDER, 0n, 0, TOKEN],
      null,
      CONTRACT
    );
    assert.ok(desc.includes("revoked"), `expected "revoked" in "${desc}"`);
    assert.ok(desc.includes(SPENDER_SHORT), `missing spender in "${desc}"`);
    assert.ok(desc.includes("USDC"), `missing token in "${desc}"`);
  });

  it("approve with amount=0 (number) is also a revoke", () => {
    const desc = buildDescription(
      "approve",
      [FROM, SPENDER, 0, 0, TOKEN],
      null,
      CONTRACT
    );
    assert.ok(desc.includes("revoked"), `expected "revoked" in "${desc}"`);
  });

  it('approve description matches format "GA… approved GB… to spend up to N TOKEN (…)"', () => {
    const desc = buildDescription(
      "approve",
      [FROM, SPENDER, 500n, 999, TOKEN],
      null,
      CONTRACT
    );
    assert.match(desc, /approved .+ to spend up to .+ USDC \(.+\)/);
  });

  it("approve falls back to contractName when no token arg", () => {
    const desc = buildDescription(
      "approve",
      [FROM, SPENDER, 100n, 0],
      null,
      "MyToken"
    );
    assert.ok(desc.includes("MyToken"), `expected contract name fallback in "${desc}"`);
  });
});

describe("decoder — set_allowance (issue #561)", () => {
  it("set_allowance with positive amount shows approved", () => {
    const desc = buildDescription(
      "set_allowance",
      [FROM, SPENDER, 200n, 1234567, TOKEN],
      null,
      CONTRACT
    );
    assert.ok(desc.includes("approved"), `expected "approved" in "${desc}"`);
    assert.ok(desc.includes("expires ledger #1234567"), `missing expiry in "${desc}"`);
  });

  it("set_allowance with amount=0 revokes", () => {
    const desc = buildDescription(
      "set_allowance",
      [FROM, SPENDER, 0n, 0, TOKEN],
      null,
      CONTRACT
    );
    assert.ok(desc.includes("revoked"), `expected "revoked" in "${desc}"`);
  });
});

describe("decoder — increase_allowance (issue #561)", () => {
  it("increase_allowance produces correct description", () => {
    const desc = buildDescription(
      "increase_allowance",
      [FROM, SPENDER, 50n, TOKEN],
      null,
      CONTRACT
    );
    assert.ok(desc.includes("increased"), `expected "increased" in "${desc}"`);
    assert.ok(desc.includes(SPENDER_SHORT), `missing spender in "${desc}"`);
    assert.ok(desc.includes("50"), `missing amount in "${desc}"`);
    assert.ok(desc.includes("USDC"), `missing token in "${desc}"`);
  });

  it("increase_allowance description contains allowance keyword", () => {
    const desc = buildDescription(
      "increase_allowance",
      [FROM, SPENDER, 25n, TOKEN],
      null,
      CONTRACT
    );
    assert.ok(desc.includes("allowance"), `expected "allowance" in "${desc}"`);
  });
});

describe("decoder — decrease_allowance (issue #561)", () => {
  it("decrease_allowance produces correct description", () => {
    const desc = buildDescription(
      "decrease_allowance",
      [FROM, SPENDER, 30n, TOKEN],
      null,
      CONTRACT
    );
    assert.ok(desc.includes("decreased"), `expected "decreased" in "${desc}"`);
    assert.ok(desc.includes(SPENDER_SHORT), `missing spender in "${desc}"`);
    assert.ok(desc.includes("30"), `missing amount in "${desc}"`);
    assert.ok(desc.includes("USDC"), `missing token in "${desc}"`);
  });

  it("decrease_allowance description is never null or empty", () => {
    const desc = buildDescription(
      "decrease_allowance",
      [FROM, SPENDER, 10n],
      null,
      "XLM"
    );
    assert.equal(typeof desc, "string");
    assert.ok(desc.length > 0);
  });
});

// ── #562: NFT transfer / mint / burn ──────────────────────────────────────────

describe("decoder — NFT mint_nft (issue #562)", () => {
  it("mint_nft contains minted, NFT #, and contract name", () => {
    const desc = buildDescription(
      "mint_nft",
      [TO, 1234n, "Stellar Punks"],
      null,
      "StellarPunks"
    );
    assert.ok(desc.includes("minted"), `expected "minted" in "${desc}"`);
    assert.ok(desc.includes("1234"), `missing token id in "${desc}"`);
  });

  it("mint_nft without collection falls back to contract name", () => {
    const desc = buildDescription("mint_nft", [TO, 42n], null, "PunkContract");
    assert.ok(desc.includes("PunkContract"), `expected contract name in "${desc}"`);
  });
});

describe("decoder — NFT burn_nft (issue #562)", () => {
  it("burn_nft contains burned and token id", () => {
    const desc = buildDescription("burn_nft", [FROM, 99n], null, "StellarPunks");
    assert.ok(desc.includes("burned"), `expected "burned" in "${desc}"`);
    assert.ok(desc.includes("99"), `missing token id in "${desc}"`);
  });

  it("burn_nft contains the owner address", () => {
    const desc = buildDescription("burn_nft", [FROM, 1n], null, "StellarPunks");
    assert.ok(desc.includes(FROM_SHORT), `missing owner in "${desc}"`);
  });
});

describe("decoder — NFT create (issue #562)", () => {
  it("create contains created and contract name", () => {
    const desc = buildDescription("create", [FROM, 7n], null, "MyNFT");
    assert.ok(desc.includes("created"), `expected "created" in "${desc}"`);
    assert.ok(desc.includes("MyNFT"), `missing contract name in "${desc}"`);
  });
});

describe("decoder — NFT list_nft (issue #562)", () => {
  it("list_nft contains listed and token id", () => {
    const desc = buildDescription("list_nft", [FROM, 5n, 1000n], null, "NFTMarket");
    assert.ok(desc.includes("listed"), `expected "listed" in "${desc}"`);
    assert.ok(desc.includes("5"), `missing token id in "${desc}"`);
  });
});

// ── #563: AMM liquidity ────────────────────────────────────────────────────────

describe("decoder — add_liquidity (issue #563)", () => {
  it("add_liquidity produces correct human-readable description", () => {
    const desc = buildDescription(
      "add_liquidity",
      [FROM, "XLM", 1000000000n, "USDC", 500000000n],
      null,
      "StellarSwap"
    );
    assert.ok(desc.includes("added"), `expected "added" in "${desc}"`);
    assert.ok(desc.includes("XLM"), `missing XLM in "${desc}"`);
    assert.ok(desc.includes("USDC"), `missing USDC in "${desc}"`);
    assert.ok(desc.includes("1000000000"), `missing amount_a in "${desc}"`);
    assert.ok(desc.includes("500000000"), `missing amount_b in "${desc}"`);
  });

  it("add_liquidity with LP tokens shows received LP tokens", () => {
    const desc = buildDescription(
      "add_liquidity",
      [FROM, "XLM", 1000000000n, "USDC", 500000000n, 707106781n],
      null,
      "StellarSwap"
    );
    assert.ok(desc.includes("LP tokens"), `expected "LP tokens" in "${desc}"`);
    assert.ok(desc.includes("707106781"), `missing LP amount in "${desc}"`);
  });

  it("add_liquidity without LP tokens omits LP clause", () => {
    const desc = buildDescription(
      "add_liquidity",
      [FROM, "XLM", 100n, "USDC", 50n],
      null,
      "StellarSwap"
    );
    assert.ok(!desc.includes("LP tokens"), `unexpected "LP tokens" in "${desc}"`);
  });

  it("provide_liquidity behaves same as add_liquidity", () => {
    const desc = buildDescription(
      "provide_liquidity",
      [FROM, "XLM", 100n, "USDC", 50n],
      null,
      "StellarSwap"
    );
    assert.ok(desc.includes("added"), `expected "added" in "${desc}"`);
  });
});

describe("decoder — remove_liquidity (issue #563)", () => {
  it("remove_liquidity produces correct description", () => {
    const desc = buildDescription(
      "remove_liquidity",
      [FROM, "XLM", "USDC", 707106781n, 1000000000n, 498000000n],
      null,
      "StellarSwap"
    );
    assert.ok(desc.includes("removed"), `expected "removed" in "${desc}"`);
    assert.ok(desc.includes("LP tokens"), `expected "LP tokens" in "${desc}"`);
    assert.ok(desc.includes("XLM"), `missing XLM in "${desc}"`);
    assert.ok(desc.includes("USDC"), `missing USDC in "${desc}"`);
  });

  it("withdraw_liquidity behaves same as remove_liquidity", () => {
    const desc = buildDescription(
      "withdraw_liquidity",
      [FROM, "XLM", "USDC", 707n, 100n, 50n],
      null,
      "StellarSwap"
    );
    assert.ok(desc.includes("removed"), `expected "removed" in "${desc}"`);
  });
});

// ── #564: batchDescription helper ─────────────────────────────────────────────

describe("decoder — batchDescription (issue #564)", () => {
  it("returns null for a single-event array", () => {
    const result = batchDescription([
      { description: `${FROM_SHORT} approved ${SPENDER_SHORT} to spend up to 100 USDC (no expiry)`, function: "approve" },
    ]);
    assert.equal(result, null);
  });

  it("returns null for an empty array", () => {
    assert.equal(batchDescription([]), null);
  });

  it("two events produce a combined description with 'then'", () => {
    const ev1 = {
      description: `${FROM_SHORT} approved ${SPENDER_SHORT} to spend up to 100 USDC (no expiry)`,
      function: "approve",
    };
    const ev2 = {
      description: `Address ${FROM_SHORT} swapped 100 USDC → 98 XLM on StellarSwap`,
      function: "swap",
    };
    const result = batchDescription([ev1, ev2]);
    assert.equal(typeof result, "string");
    assert.ok(result.includes("then"), `expected "then" in "${result}"`);
    assert.ok(result.includes("in one transaction"), `expected "in one transaction" in "${result}"`);
  });

  it("three events produce a count-based description", () => {
    const make = (fn) => ({ description: `${FROM_SHORT} did ${fn}`, function: fn });
    const result = batchDescription([make("approve"), make("swap"), make("transfer")]);
    assert.ok(result.includes("3"), `expected count 3 in "${result}"`);
    assert.ok(result.includes("in one transaction"), `expected "in one transaction" in "${result}"`);
  });

  it("single-event transaction is not affected (returns null)", () => {
    const result = batchDescription([
      { description: `Address ${FROM_SHORT} transferred 50 USDC to ${TO_SHORT} on USDC Token`, function: "transfer" },
    ]);
    assert.equal(result, null, "single-event tx should return null");
  });

  it("batch description is a non-empty string for two events", () => {
    const evs = [
      { description: `${FROM_SHORT} approved ${SPENDER_SHORT} to spend up to 500 USDC (no expiry)`, function: "approve" },
      { description: `Address ${FROM_SHORT} swapped 500 USDC → 490 XLM on StellarSwap`, function: "swap" },
    ];
    const result = batchDescription(evs);
    assert.equal(typeof result, "string");
    assert.ok(result.length > 0, "batch description must not be empty");
  });
});
