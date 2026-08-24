import { jest } from "@jest/globals";

// Issue #544 — horizonClient.resolveAsset() unit tests.
// Mocks @stellar/stellar-sdk directly and imports only horizonClient.js
// (no api.js/db.js) so this suite needs no database connection and no
// network access — DATABASE_URL is set only to satisfy config.js validation
// at import time (config.js is a transitive import via cacheLayer.js).
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/soroban_test";

const mockCall = jest.fn();

jest.unstable_mockModule("@stellar/stellar-sdk", () => ({
  Horizon: {
    Server: class MockHorizonServer {
      assets() {
        return {
          forCode: () => ({
            forIssuer: () => ({ call: mockCall }),
          }),
        };
      }
    },
  },
}));

const { resolveAsset } = await import("../../src/horizonClient.js");

const ISSUER = "GA22K667OGPC3R32NRJTNQG4KWT2OFGHNNGZ2JQMSIGLT7AFHVIOMJ43";

describe("horizonClient.resolveAsset", () => {
  beforeEach(() => {
    mockCall.mockReset();
  });

  it("maps a Horizon asset record to { name, code, issuer, decimals, domain }", async () => {
    mockCall.mockResolvedValue({
      records: [
        {
          asset_code: "USDC",
          asset_issuer: ISSUER,
          _links: { toml: { href: "https://centre.io/.well-known/stellar.toml" } },
        },
      ],
    });

    const asset = await resolveAsset(ISSUER, "USDC");
    expect(asset).toEqual({
      name: "USDC",
      code: "USDC",
      issuer: ISSUER,
      decimals: 7,
      domain: "centre.io",
    });
  });

  it("returns null when Horizon has no matching asset record", async () => {
    mockCall.mockResolvedValue({ records: [] });
    const asset = await resolveAsset(ISSUER, "NOPE");
    expect(asset).toBeNull();
  });

  it("returns null domain when the issuer has no stellar.toml link", async () => {
    mockCall.mockResolvedValue({
      records: [{ asset_code: "XYZ", asset_issuer: ISSUER, _links: { toml: { href: "" } } }],
    });
    const asset = await resolveAsset(ISSUER, "XYZ");
    expect(asset?.domain).toBeNull();
  });

  it("returns null without calling Horizon when issuer or code is missing", async () => {
    expect(await resolveAsset("", "USDC")).toBeNull();
    expect(await resolveAsset(ISSUER, "")).toBeNull();
    expect(mockCall).not.toHaveBeenCalled();
  });

  it("caches a resolved asset so a second lookup does not call Horizon again", async () => {
    mockCall.mockResolvedValue({
      records: [{ asset_code: "CACHED_UNIT", asset_issuer: ISSUER, _links: { toml: { href: "" } } }],
    });

    await resolveAsset(ISSUER, "CACHED_UNIT");
    await resolveAsset(ISSUER, "CACHED_UNIT");

    expect(mockCall).toHaveBeenCalledTimes(1);
  });
});
