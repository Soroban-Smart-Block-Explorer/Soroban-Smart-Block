/**
 * Stage-2 decoder tests: end-to-end description generation.
 * One test per function type: swap, transfer, mint, burn, stake.
 *
 * Uses synthetic decoded event objects (the native JS values that
 * scValToNative() would produce from raw XDR) and feeds them through
 * buildDescription() to verify human-readable output.
 *
 * Closes #582, #583, #584, #585
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildDescription } from "../src/decoder.js";

// ── Shared fixtures ────────────────────────────────────────────────────────

const FROM_ADDR = "GABC123DEF456GHI789JKL012MNO345PQR678STU901VWX234YZ";
const TO_ADDR   = "GBCD234DEF567GHI890JKL123MNO456PQR789STU012VWX345YZ";
const CONTRACT  = "USDC Token";

// Synthetic decoded event objects — these mirror what scValToNative()
// returns for real on-chain events after XDR deserialization.

const SWAP_EVENT = {
  contractId: CONTRACT,
  fn: "swap",
  args: [
    FROM_ADDR,          // from
    5000000n,           // amtIn  (5 USDC at 6 decimals)
    "USDC",             // tokenIn
    3500000000000n,     // amtOut (3500 XLM at 7 decimals)
    "XLM",              // tokenOut
  ],
  tokenCode: "USDC",
  amount: "5000000",
};

const TRANSFER_EVENT = {
  contractId: CONTRACT,
  fn: "transfer",
  args: [
    FROM_ADDR,          // from
    TO_ADDR,            // to
    100000000n,         // amount (100 USDC)
    "USDC",             // token
  ],
  tokenCode: "USDC",
  amount: "100000000",
};

const MINT_EVENT = {
  contractId: CONTRACT,
  fn: "mint",
  args: [
    TO_ADDR,            // to
    500000000n,         // amount (500 USDC)
    "USDC",             // token
  ],
  tokenCode: "USDC",
  amount: "500000000",
};

const BURN_EVENT = {
  contractId: CONTRACT,
  fn: "burn",
  args: [
    FROM_ADDR,          // from
    250000000n,         // amount (250 USDC)
    "USDC",             // token
  ],
  tokenCode: "USDC",
  amount: "250000000",
};

const STAKE_EVENT = {
  contractId: "StakeVault",
  fn: "stake",
  args: [
    FROM_ADDR,          // staker
    10000000000n,       // amount (1000 XLM in stroops)
    30,                 // duration in days
  ],
  tokenCode: "XLM",
  amount: "10000",
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe("decoder stage2 — swap description", () => {
  const desc = buildDescription(
    SWAP_EVENT.fn,
    SWAP_EVENT.args,
    null,
    SWAP_EVENT.contractId,
  );

  it("description contains token codes USDC and XLM", () => {
    assert.ok(desc.includes("USDC"), `expected "USDC" in "${desc}"`);
    assert.ok(desc.includes("XLM"),  `expected "XLM" in "${desc}"`);
  });

  it("description contains input and output amounts", () => {
    assert.ok(desc.includes("5000000"), `expected input amount in "${desc}"`);
    assert.ok(desc.includes("3500000000000"), `expected output amount in "${desc}"`);
  });

  it("decoded: true — description is meaningful", () => {
    assert.ok(desc && desc.length > 0, "description must be non-empty");
    assert.ok(desc.includes("swapped"), "expected 'swapped' keyword");
  });
});

describe("decoder stage2 — transfer description", () => {
  const desc = buildDescription(
    TRANSFER_EVENT.fn,
    TRANSFER_EVENT.args,
    null,
    TRANSFER_EVENT.contractId,
  );

  it("description contains token code USDC", () => {
    assert.ok(desc.includes("USDC"), `expected "USDC" in "${desc}"`);
  });

  it("description contains the amount", () => {
    assert.ok(desc.includes("100000000"), `expected amount in "${desc}"`);
  });

  it("decoded: true — description is meaningful", () => {
    assert.ok(desc && desc.length > 0, "description must be non-empty");
    assert.ok(desc.includes("transferred"), "expected 'transferred' keyword");
  });
});

describe("decoder stage2 — mint description", () => {
  const desc = buildDescription(
    MINT_EVENT.fn,
    MINT_EVENT.args,
    null,
    MINT_EVENT.contractId,
  );

  it("description contains token code USDC", () => {
    assert.ok(desc.includes("USDC"), `expected "USDC" in "${desc}"`);
  });

  it("description contains the amount", () => {
    assert.ok(desc.includes("500000000"), `expected amount in "${desc}"`);
  });

  it("decoded: true — description is meaningful", () => {
    assert.ok(desc && desc.length > 0, "description must be non-empty");
    assert.ok(desc.includes("minted"), "expected 'minted' keyword");
  });
});

describe("decoder stage2 — burn description", () => {
  const desc = buildDescription(
    BURN_EVENT.fn,
    BURN_EVENT.args,
    null,
    BURN_EVENT.contractId,
  );

  it("description contains token code USDC", () => {
    assert.ok(desc.includes("USDC"), `expected "USDC" in "${desc}"`);
  });

  it("description contains the amount", () => {
    assert.ok(desc.includes("250000000"), `expected amount in "${desc}"`);
  });

  it("decoded: true — description is meaningful", () => {
    assert.ok(desc && desc.length > 0, "description must be non-empty");
    assert.ok(desc.includes("burned"), "expected 'burned' keyword");
  });
});

describe("decoder stage2 — stake description", () => {
  const desc = buildDescription(
    STAKE_EVENT.fn,
    STAKE_EVENT.args,
    null,
    STAKE_EVENT.contractId,
  );

  it("description contains token code XLM", () => {
    assert.ok(desc.includes("XLM"), `expected "XLM" in "${desc}"`);
  });

  it("description contains the formatted amount", () => {
    assert.ok(desc.includes("1,000") || desc.includes("10000"),
      `expected formatted amount in "${desc}"`);
  });

  it("decoded: true — description is meaningful", () => {
    assert.ok(desc && desc.length > 0, "description must be non-empty");
  });
});
