/**
 * Unit tests for classic Stellar payment/path-payment decoding in
 * indexer/src/decoder.js (#545, #548).
 *
 * decode() dispatches to decodeClassicOperation() whenever ev.contractId is
 * null and an ev.operation (Horizon operation record) is present — no
 * Soroban RPC event or database access is involved on this path, so these
 * tests run without a live Postgres instance.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { decode, decodeClassicOperation } from "../src/decoder.js";
import { _clearCache } from "../src/horizonClient.js";

const FROM = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF5";
const TO = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBFQIE";
const USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const EURC_ISSUER = "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2";

/** Stub global fetch: Horizon /accounts/{issuer} -> home_domain, then TOML -> CURRENCIES. */
function mockHorizon({ homeDomain = "centre.io", toml } = {}) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/accounts/")) {
      return {
        ok: true,
        json: async () => (homeDomain ? { home_domain: homeDomain } : {}),
      };
    }
    if (u.includes("/.well-known/stellar.toml")) {
      return {
        ok: toml !== undefined,
        text: async () => toml ?? "",
      };
    }
    return { ok: false };
  };
}

beforeEach(() => {
  _clearCache();
});

describe("decodeClassicOperation — payment", () => {
  it("decodes a classic XLM payment", async () => {
    const decoded = await decode({
      contractId: null,
      ledger: 1000,
      txHash: "tx1",
      operation: {
        type: "payment",
        from: FROM,
        to: TO,
        amount: "100.0000000",
        asset_type: "native",
      },
    });

    assert.equal(decoded.type, "classic");
    assert.equal(decoded.contract_id, "");
    assert.equal(decoded.function, "payment");
    assert.match(decoded.description, /^Address GAAAAA…WHF5 sent 100\.00 XLM to GBBBBB…FQIE$/);
    assert.equal(decoded.ledger, 1000);
    assert.equal(decoded.tx_hash, "tx1");
  });

  it("resolves the asset name for a non-native payment via stellar.toml", async () => {
    mockHorizon({
      homeDomain: "centre.io",
      toml: `
[[CURRENCIES]]
code = "USDC"
issuer = "${USDC_ISSUER}"
name = "Centre Consortium"
image = "https://centre.io/logo.png"
`,
    });

    const decoded = await decodeClassicOperation({
      ledger: 1001,
      txHash: "tx2",
      operation: {
        type: "payment",
        from: FROM,
        to: TO,
        amount: "50.0000000",
        asset_type: "credit_alphanum4",
        asset_code: "USDC",
        asset_issuer: USDC_ISSUER,
      },
    });

    assert.match(decoded.description, /sent 50\.00 USDC \(Centre Consortium\) to/);
  });

  it("falls back to the bare asset code when no TOML/name is found", async () => {
    mockHorizon({ homeDomain: null });

    const decoded = await decodeClassicOperation({
      ledger: 1002,
      txHash: "tx3",
      operation: {
        type: "payment",
        from: FROM,
        to: TO,
        amount: "10.0000000",
        asset_type: "credit_alphanum4",
        asset_code: "UNKN",
        asset_issuer: USDC_ISSUER,
      },
    });

    assert.match(decoded.description, /sent 10\.00 UNKN to/);
    assert.doesNotMatch(decoded.description, /\(/);
  });
});

describe("decodeClassicOperation — path payments", () => {
  it("decodes a 3-hop path payment with all intermediate assets listed", async () => {
    mockHorizon({ homeDomain: null }); // no TOML resolution needed for this case

    const decoded = await decodeClassicOperation({
      ledger: 2000,
      txHash: "tx4",
      operation: {
        type: "path_payment_strict_send",
        from: FROM,
        to: TO,
        source_amount: "100.0000000",
        source_asset_type: "native",
        amount: "89.5000000",
        asset_type: "credit_alphanum4",
        asset_code: "EURC",
        asset_issuer: EURC_ISSUER,
        path: [
          { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: USDC_ISSUER },
          { asset_type: "credit_alphanum4", asset_code: "EURC", asset_issuer: EURC_ISSUER },
        ],
      },
    });

    assert.equal(decoded.type, "classic");
    assert.equal(decoded.function, "path_payment_strict_send");
    assert.match(decoded.description, /swapped 100\.00 XLM → \[USDC → EURC\] → 89\.50 EURC/);
  });

  it("decodes an empty path array as a direct swap with no brackets", async () => {
    mockHorizon({ homeDomain: null });

    const decoded = await decodeClassicOperation({
      ledger: 2001,
      txHash: "tx5",
      operation: {
        type: "path_payment_strict_receive",
        from: FROM,
        to: TO,
        source_amount: "100.0000000",
        source_asset_type: "native",
        amount: "89.5000000",
        asset_type: "credit_alphanum4",
        asset_code: "EURC",
        asset_issuer: EURC_ISSUER,
        path: [],
      },
    });

    assert.match(decoded.description, /swapped 100\.00 XLM → 89\.50 EURC/);
    assert.doesNotMatch(decoded.description, /[[\]]/);
  });

  it("a direct payment (not a path payment) has no brackets or swap arrows", async () => {
    const decoded = await decodeClassicOperation({
      ledger: 2002,
      txHash: "tx6",
      operation: {
        type: "payment",
        from: FROM,
        to: TO,
        amount: "100.0000000",
        asset_type: "native",
      },
    });

    assert.doesNotMatch(decoded.description, /[[\]]/);
    assert.doesNotMatch(decoded.description, /swapped/);
  });
});
