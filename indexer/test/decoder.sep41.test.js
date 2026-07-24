/**
 * Unit tests: decoder.js SEP-41 transfer description format.
 * Closes #418
 *
 * SEP-41 transfer description format (from buildDescription):
 *   "Address {short-from} transferred {amount} {token} to {short-to} on {contractName}"
 * where addresses are shortened to "AAAAAA…ZZZZ" (first 6 + last 4 chars).
 *
 * Test vectors use hardcoded known-good ScVal-decoded values that mirror what
 * scValToNative() would return for a real on-chain SEP-41 transfer event.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { xdr, scValToNative } from "@stellar/stellar-sdk";
import { buildDescription } from "../src/decoder.js";

// ── Known-good XDR-derived test values ────────────────────────────────────────
// These mirror what scValToNative() returns for a real SEP-41 transfer event.

// Sender address — 56-char G-address (scvAddress → account)
const FROM = "G" + "A".repeat(55);
// Recipient address — 56-char G-address
const TO = "G" + "B".repeat(55);
// Token code (scvSymbol)
const TOKEN = "USDC";
// Contract display label
const CONTRACT_LABEL = "USDC Token";

// Amount decoded from scvI128 via scValToNative → bigint
const AMOUNT_I128 = scValToNative(
  xdr.ScVal.scvI128(
    new xdr.Int128Parts({
      hi: xdr.Int64.fromString("0"),
      lo: xdr.Uint64.fromString("100000000"),
    })
  )
);

// ── SEP-41 transfer ──────────────────────────────────────────────────────────

describe("decoder — SEP-41 transfer description", () => {
  it("description contains the token symbol", () => {
    const desc = buildDescription("transfer", [FROM, TO, AMOUNT_I128, TOKEN], null, CONTRACT_LABEL);
    assert.ok(desc.includes(TOKEN), `expected "${TOKEN}" in "${desc}"`);
  });

  it("description contains the amount", () => {
    const desc = buildDescription("transfer", [FROM, TO, AMOUNT_I128, TOKEN], null, CONTRACT_LABEL);
    assert.ok(
      desc.includes(String(AMOUNT_I128)),
      `expected amount "${AMOUNT_I128}" in "${desc}"`
    );
  });

  it("description contains the contract name", () => {
    const desc = buildDescription("transfer", [FROM, TO, AMOUNT_I128, TOKEN], null, CONTRACT_LABEL);
    assert.ok(desc.includes(CONTRACT_LABEL), `expected "${CONTRACT_LABEL}" in "${desc}"`);
  });

  it("description matches the documented format", () => {
    // Full format: "Address {short-from} transferred {amount} {token} to {short-to} on {contractName}"
    const desc = buildDescription("transfer", [FROM, TO, AMOUNT_I128, TOKEN], null, CONTRACT_LABEL);
    assert.match(desc, /^Address .+ transferred .+ to .+ on .+$/);
  });

  it("description includes 'transferred' keyword", () => {
    const desc = buildDescription("transfer", [FROM, TO, 100n, TOKEN], null, CONTRACT_LABEL);
    assert.ok(desc.includes("transferred"), `expected "transferred" in "${desc}"`);
  });

  it("short addresses use head…tail format", () => {
    const desc = buildDescription("transfer", [FROM, TO, 100n, TOKEN], null, CONTRACT_LABEL);
    // FROM starts with "GAAA", first 6 chars = "GAAAAA", last 4 chars = "AAAA"
    assert.ok(desc.includes("GAAAAA…AAAA"), `expected truncated from address in "${desc}"`);
  });

  it("description is never null or empty when token is omitted", () => {
    const desc = buildDescription("transfer", [FROM, TO, 100n], null, CONTRACT_LABEL);
    assert.equal(typeof desc, "string");
    assert.ok(desc.length > 0);
    assert.ok(desc.includes("transferred"));
  });
});

// ── SEP-41 mint ──────────────────────────────────────────────────────────────

describe("decoder — SEP-41 mint description", () => {
  it("description contains minted keyword and token", () => {
    const desc = buildDescription("mint", [TO, AMOUNT_I128, TOKEN], null, CONTRACT_LABEL);
    assert.ok(desc.includes("minted"), `expected "minted" in "${desc}"`);
    assert.ok(desc.includes(TOKEN));
  });
});

// ── SEP-41 burn ──────────────────────────────────────────────────────────────

describe("decoder — SEP-41 burn description", () => {
  it("description contains burned keyword and token", () => {
    const desc = buildDescription("burn", [FROM, AMOUNT_I128, TOKEN], null, CONTRACT_LABEL);
    assert.ok(desc.includes("burned"), `expected "burned" in "${desc}"`);
    assert.ok(desc.includes(TOKEN));
  });
});
