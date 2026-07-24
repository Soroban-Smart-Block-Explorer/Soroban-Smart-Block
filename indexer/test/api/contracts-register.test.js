import request from "supertest";

// Issue #414: POST /api/contracts is the HTTP surface for ABI registration.
// It must persist the metadata and return 201, the stored metadata must be
// retrievable via GET /api/contracts/:id, and an invalid body (missing required
// fields) must return 400.

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/soroban_test";
process.env.DATABASE_URL = DB_URL;
process.env.API_KEY = "test-api-key";
// Skip on-chain ABI verification so the test does not require RPC access.
process.env.VERIFY_ABI = "false";

const { db } = await import("../../src/db.js");
const { startApi } = await import("../../src/api.js");

describe("POST /api/contracts (issue #414)", () => {
  let server;
  const contractId = "CABITEST414ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJK";

  beforeAll(async () => {
    await db.init();
    await db.query("DELETE FROM contracts WHERE id = $1", [contractId]);
    server = startApi();
  });

  afterAll(async () => {
    if (server && server.close) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("stores ABI metadata and returns 201", async () => {
    const body = {
      id: contractId,
      name: "ABI Test Token",
      description: "Minimal valid ContractMeta for issue #414",
      functions: [{ name: "transfer", description: "Move tokens", args: [] }],
      registered_by: "test-admin",
    };

    const res = await request(server)
      .post("/api/contracts")
      .set("x-api-key", "test-api-key")
      .send(body);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true });

    // Subsequent GET returns the stored metadata.
    const getRes = await request(server).get(`/api/contracts/${contractId}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.id).toBe(contractId);
    expect(getRes.body.name).toBe("ABI Test Token");
  });

  it("returns 400 for an invalid body (missing required fields)", async () => {
    const res = await request(server)
      .post("/api/contracts")
      .set("x-api-key", "test-api-key")
      .send({ id: "CMISSINGFUNCTIONS414" }); // no functions

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });
});
