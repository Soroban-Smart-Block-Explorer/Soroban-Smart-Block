/**
 * Unit tests for indexer/src/horizonClient.js (#546): stellar.toml parsing
 * and asset name/logo resolution, with global fetch stubbed out.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resolveToml, resolveAsset, _clearCache } from "../src/horizonClient.js";

const ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

beforeEach(() => {
  _clearCache();
});

describe("resolveToml", () => {
  it("parses multiple [[CURRENCIES]] entries", async () => {
    globalThis.fetch = async () => ({
      ok: true,
      text: async () => `
FEDERATION_SERVER="https://centre.io/federation"

[[CURRENCIES]]
code = "USDC"
issuer = "${ISSUER}"
name = "Centre Consortium"
image = "https://centre.io/usdc.png"

[[CURRENCIES]]
code = "EURC"
issuer = "GDEURC000000000000000000000000000000000000000000000000"
name = "Centre EURC"
`,
    });

    const currencies = await resolveToml("centre.io");
    assert.equal(currencies.length, 2);
    assert.deepEqual(currencies[0], {
      code: "USDC",
      issuer: ISSUER,
      name: "Centre Consortium",
      image: "https://centre.io/usdc.png",
    });
    assert.equal(currencies[1].code, "EURC");
    assert.equal(currencies[1].image, null);
  });

  it("returns an empty array when the TOML file is unreachable", async () => {
    globalThis.fetch = async () => ({ ok: false });
    assert.deepEqual(await resolveToml("no-toml.example"), []);
  });

  it("returns an empty array when fetch throws", async () => {
    globalThis.fetch = async () => {
      throw new Error("network down");
    };
    assert.deepEqual(await resolveToml("unreachable.example"), []);
  });

  it("returns an empty array for a missing domain", async () => {
    assert.deepEqual(await resolveToml(""), []);
  });
});

describe("resolveAsset", () => {
  it("resolves name and logo_url for a known asset", async () => {
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes("/accounts/")) return { ok: true, json: async () => ({ home_domain: "centre.io" }) };
      return {
        ok: true,
        text: async () => `
[[CURRENCIES]]
code = "USDC"
issuer = "${ISSUER}"
name = "Centre Consortium"
image = "https://centre.io/usdc.png"
`,
      };
    };

    const asset = await resolveAsset("USDC", ISSUER);
    assert.deepEqual(asset, { name: "Centre Consortium", logo_url: "https://centre.io/usdc.png", domain: "centre.io" });
  });

  it("returns null when the issuer account has no home_domain", async () => {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
    assert.equal(await resolveAsset("USDC", ISSUER), null);
  });

  it("returns null when the TOML has no matching CURRENCIES entry (generic placeholder case)", async () => {
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes("/accounts/")) return { ok: true, json: async () => ({ home_domain: "example.com" }) };
      return { ok: true, text: async () => `[[CURRENCIES]]\ncode = "OTHER"\n` };
    };

    assert.equal(await resolveAsset("USDC", ISSUER), null);
  });

  it("returns null for missing code or issuer", async () => {
    assert.equal(await resolveAsset("", ISSUER), null);
    assert.equal(await resolveAsset("USDC", ""), null);
  });

  it("caches repeated lookups for the same code/issuer", async () => {
    let calls = 0;
    globalThis.fetch = async (url) => {
      calls++;
      const u = String(url);
      if (u.includes("/accounts/")) return { ok: true, json: async () => ({ home_domain: "centre.io" }) };
      return { ok: true, text: async () => `[[CURRENCIES]]\ncode = "USDC"\nname = "Centre Consortium"\n` };
    };

    await resolveAsset("USDC", ISSUER);
    await resolveAsset("USDC", ISSUER);
    assert.equal(calls, 2); // one /accounts + one toml fetch, not four
  });
});
