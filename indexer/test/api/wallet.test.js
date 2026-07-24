import request from "supertest";

// Issue #415: GET /api/wallet/:address returns 200 for a valid address (empty
// array acceptable) and 400 for a malformed address.

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/soroban_test";
process.env.DATABASE_URL = DB_URL;
process.env.API_KEY = "test-api-key";

const { db } = await import("../../src/db.js");
const { startApi } = await import("../../src/api.js");

describe("GET /api/wallet/:address (issue #415)", () => {
  let server;
  // A well-formed but unseeded Stellar public key (G + 55 base32 chars).
  const validAddress = "G" + "A".repeat(55);

  beforeAll(async () => {
    await db.init();
    server = startApi();
  });

  afterAll(async () => {
    if (server && server.close) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("returns 200 with { events: [] } for a valid but unseeded address", async () => {
    const res = await request(server).get(`/api/wallet/${validAddress}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("events");
    expect(Array.isArray(res.body.events)).toBe(true);
    expect(res.body.events).toEqual([]);
  });

  it("returns 400 for an invalid address format", async () => {
    const res = await request(server).get("/api/wallet/not-a-valid-address");
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });
});
