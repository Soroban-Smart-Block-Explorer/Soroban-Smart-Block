import request from "supertest";

// Issue #416: POST /api/batch must process multiple sub-requests and return
// their results in the same order they were submitted, even if an individual
// sub-request fails (e.g. 404).

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/soroban_test";
process.env.DATABASE_URL = DB_URL;
process.env.API_KEY = "test-api-key";

const { db } = await import("../../src/db.js");
const { startApi } = await import("../../src/api.js");

describe("POST /api/batch (issue #416)", () => {
  let server;
  const contractId = "CBATCH416ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLM";

  beforeAll(async () => {
    await db.init();

    // Seed a contract and an event so the two valid sub-requests succeed.
    await db.upsertContractMeta({
      id: contractId,
      name: "Batch Contract",
      description: "Seed contract for batch ordering test",
      functions: [{ name: "transfer", args: [] }],
      registered_by: "test-admin",
    });
    await db.query(
      `INSERT INTO events (contract_id, function, ledger, tx_hash, description, raw_topics, raw_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [contractId, "transfer", 5000, "tx_batch_416", "Batch seed event", JSON.stringify([]), "{}"],
    );

    server = startApi();
  });

  afterAll(async () => {
    if (server && server.close) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("returns results in submission order, with the 404 isolated to its slot", async () => {
    // /api/batch can dispatch mutating sub-requests, so the outer POST is
    // correctly CSRF-protected. x-api-key is CSRF-exempt (machine-to-machine)
    // and this test is only concerned with ordering, not auth.
    const res = await request(server)
      .post("/api/batch")
      .set("x-api-key", "test-api-key")
      .send({
        requests: [
          { method: "GET", path: "/api/events" }, // valid -> 200
          { method: "GET", path: "/api/events/99999" }, // unknown seq -> 404
          { method: "GET", path: `/api/contracts/${contractId}` }, // valid -> 200
        ],
      });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(3);

    // Order preserved: entry 2 (index 1) reflects the 404 without breaking 1 & 3.
    expect(res.body[0].status).toBe(200);
    expect(res.body[1].status).toBe(404);
    expect(res.body[2].status).toBe(200);

    // Entries 1 and 3 still carry their successful payloads. GET /api/events
    // uses keyset pagination (#490): { data: Event[], next_cursor }, not a
    // bare array.
    expect(Array.isArray(res.body[0].body.data)).toBe(true);
    expect(res.body[2].body.id).toBe(contractId);
  });
});
