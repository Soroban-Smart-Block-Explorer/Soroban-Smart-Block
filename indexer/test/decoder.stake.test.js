/**
 * Unit tests: decoder.js stake / unstake / lock / unlock / deposit_stake.
 * Closes #560, #559, #558, #573
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildDescription } from "../src/decoder.js";

const ADDR = "G" + "A".repeat(55);
const CONTRACT = "StakeVault";
const AMOUNT = 100000000000n; // 10,000 XLM in stroops
const REWARDS = 235000000n;   // 23.5 XLM in stroops
const DURATION = 30;

// ── stake / lock / deposit_stake with duration ─────────────────────────────

describe("decoder — stake with duration", () => {
  it("stake includes duration", () => {
    const desc = buildDescription("stake", [ADDR, AMOUNT, DURATION], null, CONTRACT);
    assert.ok(desc.includes("staked"), `expected "staked" in "${desc}"`);
    assert.ok(desc.includes("30 days"), `expected "30 days" in "${desc}"`);
  });

  it("lock includes duration", () => {
    const desc = buildDescription("lock", [ADDR, AMOUNT, DURATION], null, CONTRACT);
    assert.ok(desc.includes("staked"), `expected "staked" in "${desc}"`);
    assert.ok(desc.includes("30 days"), `expected "30 days" in "${desc}"`);
  });

  it("deposit_stake includes duration", () => {
    const desc = buildDescription("deposit_stake", [ADDR, AMOUNT, DURATION], null, CONTRACT);
    assert.ok(desc.includes("staked"), `expected "staked" in "${desc}"`);
    assert.ok(desc.includes("30 days"), `expected "30 days" in "${desc}"`);
  });

  it("stake contains the amount", () => {
    const desc = buildDescription("stake", [ADDR, AMOUNT, DURATION], null, CONTRACT);
    assert.ok(desc.includes("10,000"), `expected formatted amount in "${desc}"`);
  });

  it("stake contains the contract name", () => {
    const desc = buildDescription("stake", [ADDR, AMOUNT, DURATION], null, CONTRACT);
    assert.ok(desc.includes(CONTRACT), `expected "${CONTRACT}" in "${desc}"`);
  });

  it("stake contains the address", () => {
    const desc = buildDescription("stake", [ADDR, AMOUNT, DURATION], null, CONTRACT);
    assert.ok(desc.includes("GAAAAA…AAAA"), `expected truncated address in "${desc}"`);
  });
});

// ── stake / lock / deposit_stake without duration ──────────────────────────

describe("decoder — stake without duration", () => {
  it("stake without duration omits duration clause", () => {
    const desc = buildDescription("stake", [ADDR, AMOUNT], null, CONTRACT);
    assert.ok(desc.includes("staked"), `expected "staked" in "${desc}"`);
    assert.ok(!desc.includes("days"), `should not contain "days" in "${desc}"`);
  });

  it("lock without duration omits duration clause", () => {
    const desc = buildDescription("lock", [ADDR, AMOUNT], null, CONTRACT);
    assert.ok(desc.includes("staked"), `expected "staked" in "${desc}"`);
    assert.ok(!desc.includes("days"), `should not contain "days" in "${desc}"`);
  });

  it("deposit_stake without duration omits duration clause", () => {
    const desc = buildDescription("deposit_stake", [ADDR, AMOUNT], null, CONTRACT);
    assert.ok(desc.includes("staked"), `expected "staked" in "${desc}"`);
    assert.ok(!desc.includes("days"), `should not contain "days" in "${desc}"`);
  });

  it("stake with duration=0 omits duration clause", () => {
    const desc = buildDescription("stake", [ADDR, AMOUNT, 0], null, CONTRACT);
    assert.ok(!desc.includes("days"), `should not contain "days" in "${desc}"`);
  });

  it("stake without duration still contains the amount", () => {
    const desc = buildDescription("stake", [ADDR, AMOUNT], null, CONTRACT);
    assert.ok(desc.includes("10,000"), `expected formatted amount in "${desc}"`);
  });
});

// ── unstake / unlock ───────────────────────────────────────────────────────

describe("decoder — unstake with rewards", () => {
  it("unstake includes rewards", () => {
    const desc = buildDescription("unstake", [ADDR, AMOUNT, REWARDS], null, CONTRACT);
    assert.ok(desc.includes("unstaked"), `expected "unstaked" in "${desc}"`);
    assert.ok(desc.includes("23.5"), `expected "23.5" in "${desc}"`);
    assert.ok(desc.includes("rewards"), `expected "rewards" in "${desc}"`);
  });

  it("unlock includes rewards", () => {
    const desc = buildDescription("unlock", [ADDR, AMOUNT, REWARDS], null, CONTRACT);
    assert.ok(desc.includes("unstaked"), `expected "unstaked" in "${desc}"`);
    assert.ok(desc.includes("rewards"), `expected "rewards" in "${desc}"`);
  });

  it("unstake contains the amount", () => {
    const desc = buildDescription("unstake", [ADDR, AMOUNT, REWARDS], null, CONTRACT);
    assert.ok(desc.includes("10,000"), `expected formatted amount in "${desc}"`);
  });

  it("unstake contains the contract name", () => {
    const desc = buildDescription("unstake", [ADDR, AMOUNT, REWARDS], null, CONTRACT);
    assert.ok(desc.includes(CONTRACT), `expected "${CONTRACT}" in "${desc}"`);
  });
});

describe("decoder — unstake without rewards", () => {
  it("unstake without rewards omits rewards clause", () => {
    const desc = buildDescription("unstake", [ADDR, AMOUNT], null, CONTRACT);
    assert.ok(desc.includes("unstaked"), `expected "unstaked" in "${desc}"`);
    assert.ok(!desc.includes("rewards"), `should not contain "rewards" in "${desc}"`);
  });

  it("unlock without rewards omits rewards clause", () => {
    const desc = buildDescription("unlock", [ADDR, AMOUNT], null, CONTRACT);
    assert.ok(desc.includes("unstaked"), `expected "unstaked" in "${desc}"`);
    assert.ok(!desc.includes("rewards"), `should not contain "rewards" in "${desc}"`);
  });

  it("unstake with rewards=0 omits rewards clause", () => {
    const desc = buildDescription("unstake", [ADDR, AMOUNT, 0], null, CONTRACT);
    assert.ok(!desc.includes("rewards"), `should not contain "rewards" in "${desc}"`);
  });
});
