import request from "supertest";

// Issue #415: GET /api/wallet/:address returns 200 for a valid address (empty
// array acceptable) and 400 for a malformed address.
//
// Issue #534: responses are cached for 60s (X-Cache: MISS then HIT), and the
// cache is invalidated via the same cacheInvalidate("wallet:events:*") call
// index.js makes after indexing a new event.

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/soroban_test";
process.env.DATABASE_URL = DB_URL;
process.env.API_KEY = "test-api-key";

const { db } = await import("../../src/db.js");
const { startApi } = await import("../../src/api.js");
const { cacheInvalidate } = await import("../../src/cacheLayer.js");

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

describe("GET /api/wallet/:address caching (issue #534)", () => {
  let server;
  const address = "G" + "B".repeat(55);

  beforeAll(async () => {
    await db.init();
    server = startApi();
  });

  afterAll(async () => {
    if (server && server.close) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("serves the second call within 60s from cache (X-Cache: MISS then HIT)", async () => {
    const first = await request(server).get(`/api/wallet/${address}`);
    expect(first.status).toBe(200);
    expect(first.headers["x-cache"]).toBe("MISS");

    const second = await request(server).get(`/api/wallet/${address}`);
    expect(second.status).toBe(200);
    expect(second.headers["x-cache"]).toBe("HIT");
  });

  it("busts the cache when cacheInvalidate('wallet:events:*') is called (as index.js does on new events)", async () => {
    await request(server).get(`/api/wallet/${address}`); // warm the cache
    const cached = await request(server).get(`/api/wallet/${address}`);
    expect(cached.headers["x-cache"]).toBe("HIT");

    await cacheInvalidate("wallet:events:*");

    const afterInvalidate = await request(server).get(`/api/wallet/${address}`);
    expect(afterInvalidate.headers["x-cache"]).toBe("MISS");
  });
});
