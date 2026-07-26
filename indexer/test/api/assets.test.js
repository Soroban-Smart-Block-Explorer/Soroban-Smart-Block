import { jest } from "@jest/globals";
import request from "supertest";

// Issue #544 — GET /api/assets/:issuer/:code route wiring and caching.
// horizonClient.js itself is unit-tested in horizon-client.test.js; here we
// mock it to verify the route wires resolveAsset() correctly and that the
// makeCache("asset_metadata") layer produces the expected HTTP semantics.

const DB_URL =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/soroban_test";
process.env.DATABASE_URL = DB_URL;

const resolveAssetMock = jest.fn();
jest.unstable_mockModule("../../src/horizonClient.js", () => ({ resolveAsset: resolveAssetMock }));

const { db } = await import("../../src/db.js");
const { startApi } = await import("../../src/api.js");

const ISSUER = "GA22K667OGPC3R32NRJTNQG4KWT2OFGHNNGZ2JQMSIGLT7AFHVIOMJ43";

describe("GET /api/assets/:issuer/:code", () => {
  let server;

  beforeAll(async () => {
    await db.init();
    server = startApi();
  });

  afterAll(async () => {
    if (server && server.close) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  beforeEach(() => {
    resolveAssetMock.mockReset();
  });

  it("returns 200 with the resolved asset metadata", async () => {
    resolveAssetMock.mockResolvedValue({
      name: "USDC",
      code: "USDC",
      issuer: ISSUER,
      decimals: 7,
      domain: null,
    });

    const res = await request(server).get(`/api/assets/${ISSUER}/USDC`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ name: "USDC", code: "USDC", issuer: ISSUER, decimals: 7, domain: null });
    expect(resolveAssetMock).toHaveBeenCalledWith(ISSUER, "USDC");
  });

  it("returns 404 when the asset does not exist", async () => {
    resolveAssetMock.mockResolvedValue(null);
    const res = await request(server).get(`/api/assets/${ISSUER}/GHOST`);
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error");
  });

  it("serves a second request within 24h from cache without calling resolveAsset again", async () => {
    resolveAssetMock.mockResolvedValue({
      name: "CACHED",
      code: "CACHED",
      issuer: ISSUER,
      decimals: 7,
      domain: null,
    });

    const first = await request(server).get(`/api/assets/${ISSUER}/CACHED`);
    expect(first.status).toBe(200);
    expect(first.headers["x-cache"]).toBe("MISS");
    expect(resolveAssetMock).toHaveBeenCalledTimes(1);

    const second = await request(server).get(`/api/assets/${ISSUER}/CACHED`);
    expect(second.status).toBe(200);
    expect(second.headers["x-cache"]).toBe("HIT");
    expect(second.headers["cache-control"]).toContain("max-age=86400");
    expect(resolveAssetMock).toHaveBeenCalledTimes(1); // still 1 — served from cache
  });
});
