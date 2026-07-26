import request from "supertest";
import { jest } from "@jest/globals";

// Issue #530: GET /api/wallet/:address/balances proxies Horizon and normalises
// the response. Horizon is mocked via global.fetch so these tests don't hit
// the network.

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/soroban_test";
process.env.DATABASE_URL = DB_URL;
process.env.API_KEY = "test-api-key";

import { db } from "../../src/db.js";
import { startApi } from "../../src/api.js";

function mockFetchOnce(status, body) {
  global.fetch = jest.fn().mockResolvedValue({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  });
}

describe("GET /api/wallet/:address/balances (issue #530)", () => {
  let server;
  const originalFetch = global.fetch;

  beforeAll(async () => {
    await db.init();
    server = startApi();
  });

  afterAll(async () => {
    if (server && server.close) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("returns normalised XLM + custom asset balances for a funded address", async () => {
    const address = "G" + "B".repeat(55);
    mockFetchOnce(200, {
      balances: [
        { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: "GISSUER", balance: "42.5000000" },
        { asset_type: "native", balance: "100.0000000" },
      ],
    });

    const res = await request(server).get(`/api/wallet/${address}/balances`);

    expect(res.status).toBe(200);
    expect(res.body.balances).toEqual([
      { asset_code: "USDC", asset_issuer: "GISSUER", balance: "42.5000000", is_native: false },
      { asset_code: "XLM", asset_issuer: null, balance: "100.0000000", is_native: true },
    ]);
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining(`/accounts/${address}`));
  });

  it("returns 404 with a friendly message for an unfunded address", async () => {
    const address = "G" + "C".repeat(55);
    mockFetchOnce(404, { status: 404 });

    const res = await request(server).get(`/api/wallet/${address}/balances`);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Account not found on network" });
  });

  it("returns 502 when Horizon is unreachable", async () => {
    const address = "G" + "D".repeat(55);
    global.fetch = jest.fn().mockRejectedValue(new Error("network error"));

    const res = await request(server).get(`/api/wallet/${address}/balances`);

    expect(res.status).toBe(502);
    expect(res.body).toHaveProperty("error");
  });

  it("returns 400 for an invalid address format", async () => {
    const res = await request(server).get("/api/wallet/not-a-valid-address/balances");
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  it("serves the second request within 30s from cache without re-calling Horizon", async () => {
    const address = "G" + "E".repeat(55);
    mockFetchOnce(200, { balances: [{ asset_type: "native", balance: "7.0000000" }] });

    const first = await request(server).get(`/api/wallet/${address}/balances`);
    const second = await request(server).get(`/api/wallet/${address}/balances`);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
