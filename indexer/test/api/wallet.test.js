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

describe("GET /api/wallet/:address?fn= event-type filter (issue #532)", () => {
  let server;
  const address = "G" + "F".repeat(55);
  const events = [
    { fn: "transfer", tx: "tx_fn_transfer" },
    { fn: "swap_exact_tokens_for_tokens", tx: "tx_fn_swap" },
    { fn: "mint", tx: "tx_fn_mint" },
    { fn: "burn", tx: "tx_fn_burn" },
    { fn: "stake_tokens", tx: "tx_fn_stake" },
    { fn: "approve", tx: "tx_fn_approve" },
  ];

  beforeAll(async () => {
    await db.init();
    for (const [i, e] of events.entries()) {
      await db.query(
        `INSERT INTO events (contract_id, function, ledger, tx_hash, description, raw_topics, raw_data)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          "CFILTERTEST",
          e.fn,
          2000 + i,
          e.tx,
          `Event calling ${e.fn} for wallet ${address}`,
          JSON.stringify([address]),
          JSON.stringify({}),
        ],
      );
    }
    server = startApi();
  });

  afterAll(async () => {
    await db.query("DELETE FROM events WHERE tx_hash = ANY($1)", [events.map((e) => e.tx)]);
    if (server && server.close) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("returns every event when no fn filter is given", async () => {
    const res = await request(server).get(`/api/wallet/${address}`);
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(events.length);
  });

  it("matches swap events by prefix (swap_exact_tokens_for_tokens)", async () => {
    const res = await request(server).get(`/api/wallet/${address}?fn=swap`);
    expect(res.status).toBe(200);
    expect(res.body.events.map((e) => e.function)).toEqual(["swap_exact_tokens_for_tokens"]);
  });

  it("accepts comma-separated categories", async () => {
    const res = await request(server).get(`/api/wallet/${address}?fn=transfer,mint`);
    expect(res.status).toBe(200);
    expect(res.body.events.map((e) => e.function).sort()).toEqual(["mint", "transfer"]);
  });

  it("buckets unrecognised function names into 'other'", async () => {
    const res = await request(server).get(`/api/wallet/${address}?fn=other`);
    expect(res.status).toBe(200);
    expect(res.body.events.map((e) => e.function)).toEqual(["approve"]);
  });
});
