import { jest } from "@jest/globals";
import request from "supertest";

// Issue #551 — GET /api/wallet/:address includes a horizon_account field.
// horizonBalances.js's fetchAccountMeta() itself is responsible for shaping
// the Horizon response and caching it; here we mock it to verify the route
// wires it in via Promise.allSettled and degrades to null on failure.

const DB_URL =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/soroban_test";
process.env.DATABASE_URL = DB_URL;

const fetchAccountMetaMock = jest.fn();
const fetchWalletBalancesMock = jest.fn();
jest.unstable_mockModule("../../src/horizonBalances.js", () => ({
  fetchAccountMeta: fetchAccountMetaMock,
  fetchWalletBalances: fetchWalletBalancesMock,
  AccountNotFoundError: class AccountNotFoundError extends Error {},
}));

const { db } = await import("../../src/db.js");
const { startApi } = await import("../../src/api.js");

describe("GET /api/wallet/:address horizon_account (issue #551)", () => {
  let server;
  const funded = "G" + "F".repeat(55);
  const unfunded = "G" + "U".repeat(55);
  const errored = "G" + "E".repeat(55);

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
    fetchAccountMetaMock.mockReset();
  });

  it("includes horizon_account for a funded address", async () => {
    fetchAccountMetaMock.mockResolvedValue({
      sequence: "123456789",
      subentry_count: 3,
      home_domain: "example.com",
    });

    const res = await request(server).get(`/api/wallet/${funded}`);
    expect(res.status).toBe(200);
    expect(res.body.horizon_account).toEqual({
      sequence: "123456789",
      subentry_count: 3,
      home_domain: "example.com",
    });
    expect(fetchAccountMetaMock).toHaveBeenCalledWith(funded);
  });

  it("returns horizon_account: null for an unfunded address (Horizon 404)", async () => {
    fetchAccountMetaMock.mockResolvedValue(null);

    const res = await request(server).get(`/api/wallet/${unfunded}`);
    expect(res.status).toBe(200);
    expect(res.body.horizon_account).toBeNull();
  });

  it("returns horizon_account: null (not a 500) when Horizon fails", async () => {
    fetchAccountMetaMock.mockRejectedValue(new Error("Horizon unavailable"));

    const res = await request(server).get(`/api/wallet/${errored}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("events");
    expect(res.body.horizon_account).toBeNull();
  });
});
