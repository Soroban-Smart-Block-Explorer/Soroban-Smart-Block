/**
 * Unit tests: decoder.js Blend lending protocol handler (issue #553).
 *
 * Real Blend v2 pool event shapes (blend-contracts-v2 pool/src/events.rs):
 *   supply/withdraw/borrow/repay: topics ["<fn>", asset, from], data (amount, b/d_tokens)
 *   fill_auction: topics ["fill_auction", auction_type, user], data (filler, fill_percent, { bid, lot, block })
 *
 * SAC_ASSETS must be registered before decoder.js (which imports sac.js) is
 * first loaded, since sac.js builds its lookup map at module-init time —
 * hence the dynamic import after setting process.env below.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Asset, Contract, Networks } from "@stellar/stellar-sdk";

const ISSUER = "GA22K667OGPC3R32NRJTNQG4KWT2OFGHNNGZ2JQMSIGLT7AFHVIOMJ43";
const USDC_SAC_ID = new Contract(new Asset("USDC", ISSUER).contractId(Networks.TESTNET)).contractId();

process.env.SAC_ASSETS = JSON.stringify([{ code: "USDC", issuer: ISSUER }]);

const { blendDescription } = await import("../src/decoder.js");

const FROM = "G" + "A".repeat(55);
const FROM_SHORT = "GAAAAA…AAAA";
const OTHER_USER = "G" + "B".repeat(55);
const OTHER_USER_SHORT = "GBBBBB…BBBB";
const FILLER = "G" + "C".repeat(55);
const FILLER_SHORT = "GCCCCC…CCCC";
const LEDGER = 555;

describe("decoder — Blend supply/withdraw/borrow/repay (issue #553)", () => {
  it("supply decodes to '{from} supplied {amount} {asset} to Blend pool'", () => {
    const desc = blendDescription("supply", [USDC_SAC_ID, FROM], [5000000000n], LEDGER);
    assert.ok(desc.includes(FROM_SHORT), `missing from in "${desc}"`);
    assert.ok(desc.includes("supplied"), `missing verb in "${desc}"`);
    assert.ok(desc.includes("USDC"), `missing asset code in "${desc}"`);
    assert.ok(desc.includes("Blend pool"), `missing pool label in "${desc}"`);
    assert.ok(desc.includes(`ledger #${LEDGER}`), `missing ledger in "${desc}"`);
  });

  it("withdraw decodes with the correct verb", () => {
    const desc = blendDescription("withdraw", [USDC_SAC_ID, FROM], [1000000000n], LEDGER);
    assert.ok(desc.includes("withdrew"), `expected "withdrew" in "${desc}"`);
    assert.ok(desc.includes("USDC"));
  });

  it("borrow includes the health factor when present", () => {
    const desc = blendDescription("borrow", [USDC_SAC_ID, FROM], [2000000000n, 1000n, 1.85], LEDGER);
    assert.ok(desc.includes("borrowed"), `expected "borrowed" in "${desc}"`);
    assert.ok(desc.includes("health factor: 1.85"), `missing health factor in "${desc}"`);
  });

  it("borrow omits the health factor clause when absent", () => {
    const desc = blendDescription("borrow", [USDC_SAC_ID, FROM], [2000000000n], LEDGER);
    assert.ok(!desc.includes("health factor"), `unexpected health factor in "${desc}"`);
  });

  it("repay decodes with the correct verb", () => {
    const desc = blendDescription("repay", [USDC_SAC_ID, FROM], [1300000000n], LEDGER);
    assert.ok(desc.includes("repaid"), `expected "repaid" in "${desc}"`);
  });
});

describe("decoder — Blend liquidation via fill_auction (issue #553)", () => {
  it("includes both collateral seized and debt repaid (object-shaped Map)", () => {
    const auctionData = {
      bid: { [USDC_SAC_ID]: 1300000000n }, // debt repaid by the filler
      lot: { [USDC_SAC_ID]: 1500000000n }, // collateral seized by the filler
      block: 1000,
    };
    const desc = blendDescription("fill_auction", [0, OTHER_USER], [FILLER, 100, auctionData], LEDGER);
    assert.ok(desc.includes(FILLER_SHORT), `missing filler in "${desc}"`);
    assert.ok(desc.includes(OTHER_USER_SHORT), `missing liquidated user in "${desc}"`);
    assert.ok(desc.includes("liquidated"), `missing verb in "${desc}"`);
    assert.ok(desc.includes("seized"), `missing "seized" in "${desc}"`);
    assert.ok(desc.includes("repaid"), `missing "repaid" in "${desc}"`);
  });

  it("also accepts a native Map for bid/lot", () => {
    const auctionData = {
      bid: new Map([[USDC_SAC_ID, 1300000000n]]),
      lot: new Map([[USDC_SAC_ID, 1500000000n]]),
      block: 1000,
    };
    const desc = blendDescription("fill_auction", [0, OTHER_USER], [FILLER, 100, auctionData], LEDGER);
    assert.ok(desc.includes("seized"));
    assert.ok(desc.includes("repaid"));
  });

  it("ignores non-liquidation auction types", () => {
    const auctionData = { bid: {}, lot: {}, block: 1 };
    assert.equal(blendDescription("fill_auction", [1, OTHER_USER], [FILLER, 100, auctionData], LEDGER), null);
  });
});

describe("decoder — Blend unrelated function names", () => {
  it("returns null for a function this decoder doesn't handle", () => {
    assert.equal(blendDescription("set_admin", [FROM], [], LEDGER), null);
  });
});
