import request from "supertest";

// Issue #536: GET /api/contracts/:id/stats returns aggregate event stats for
// a contract's stats widget — total events, unique callers, first/last seen
// ledger, and a zero-filled daily trend for the sparkline.
// Issue #799: the same endpoint accepts a ?range= query param (1-365, default
// 30) so the contract detail page can render 30/90/365-day event-volume trends.

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/soroban_test";
process.env.DATABASE_URL = DB_URL;
process.env.API_KEY = "test-api-key";
process.env.VERIFY_ABI = "false";

const { db } = await import("../../src/db.js");
const { startApi } = await import("../../src/api.js");

describe("GET /api/contracts/:id/stats (issue #536)", () => {
  let server;
  const contractId = "CSTATS536ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLM";
  // Base32 strkey alphabet is [A-Z2-7] — map each caller index to a letter.
  // Uses K-T to avoid colliding with the A/B sentinel addresses other wallet
  // tests treat as "unseeded" against the shared test database.
  const callers = Array.from({ length: 10 }, (_, i) => `G${"KLMNOPQRST"[i].repeat(55)}`);

  beforeAll(async () => {
    await db.init();
    await db.query("DELETE FROM events WHERE contract_id = $1", [contractId]);

    // 100 events from 10 unique callers (10 events each).
    for (let i = 1; i <= 100; i++) {
      const caller = callers[i % callers.length];
      await db.query(
        `INSERT INTO events (contract_id, function, ledger, tx_hash, description, raw_topics, raw_data)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          contractId,
          "transfer",
          2000 + i,
          `tx_${i}`,
          `Event ${i} on ${contractId} involving ${caller}`,
          JSON.stringify([caller]),
          JSON.stringify({ amount: "1" }),
        ],
      );
    }

    server = startApi();
  });

  afterAll(async () => {
    await db.query("DELETE FROM events WHERE contract_id = $1", [contractId]);
    if (server && server.close) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("returns total_events: 100, unique_callers: 10 for the seeded contract", async () => {
    const res = await request(server).get(`/api/contracts/${contractId}/stats`);
    expect(res.status).toBe(200);
    expect(res.body.total_events).toBe(100);
    expect(res.body.unique_callers).toBe(10);
    expect(res.body.first_seen_ledger).toBe(2001);
    expect(res.body.last_seen_ledger).toBe(2100);
  });

  it("returns a 30-day zero-filled events_per_day series for a contract with no events", async () => {
    const res = await request(server).get("/api/contracts/CNOEVENTS536/stats");
    expect(res.status).toBe(200);
    expect(res.body.total_events).toBe(0);
    expect(res.body.unique_callers).toBe(0);
    expect(res.body.events_per_day).toHaveLength(30);
    expect(res.body.events_per_day.every((d) => d.count === 0)).toBe(true);
    expect(res.body.range).toBe(30);
  });

  it("returns a 90-day zero-filled series when ?range=90 (issue #799)", async () => {
    const res = await request(server).get("/api/contracts/CNOEVENTS536/stats?range=90");
    expect(res.status).toBe(200);
    expect(res.body.events_per_day).toHaveLength(90);
    expect(res.body.events_per_day.every((d) => d.count === 0)).toBe(true);
    expect(res.body.range).toBe(90);
  });

  it("returns a 365-day zero-filled series when ?range=365 (issue #799)", async () => {
    const res = await request(server).get("/api/contracts/CNOEVENTS536/stats?range=365");
    expect(res.status).toBe(200);
    expect(res.body.events_per_day).toHaveLength(365);
    expect(res.body.events_per_day.every((d) => d.count === 0)).toBe(true);
    expect(res.body.range).toBe(365);
  });

  it("rejects invalid range values with 422 (issue #799)", async () => {
    for (const bad of ["abc", "0", "-5", "366", "30.5"]) {
      const res = await request(server).get(`/api/contracts/CNOEVENTS536/stats?range=${bad}`);
      expect(res.status).toBe(422);
      expect(res.body.error).toBe("Invalid range");
    }
  });

  it("caches the response (X-Cache: MISS then HIT)", async () => {
    // Dedicated contract id — earlier tests in this file already warm the
    // cache for `contractId`, so a fresh key is needed to observe the MISS.
    const freshContractId = "CSTATSCACHE536ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGH";
    const first = await request(server).get(`/api/contracts/${freshContractId}/stats`);
    expect(first.headers["x-cache"]).toBe("MISS");
    const second = await request(server).get(`/api/contracts/${freshContractId}/stats`);
    expect(second.headers["x-cache"]).toBe("HIT");
  });
});
