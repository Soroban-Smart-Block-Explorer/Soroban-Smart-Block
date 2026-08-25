/**
 * Issue #523: PATCH /api/contracts/:id must enforce ownership.
 *
 * Acceptance criteria:
 *  - Key A registers a contract; Key B attempting to update it receives 403.
 *  - An admin key (enterprise tier) can update any contract.
 *  - Unauthenticated PATCH receives 401.
 */
import request from "supertest";

const DB_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  "postgres://postgres:postgres@localhost:5432/soroban_test";
process.env.DATABASE_URL = DB_URL;
process.env.API_KEY = "admin-static-key";
process.env.VERIFY_ABI = "false";

const { db } = await import("../../src/db.js");
const { startApi } = await import("../../src/api.js");

describe("PATCH /api/contracts/:id — ownership verification (issue #523)", () => {
  let server;
  const contractId = "COWNER523AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const validFunctions = [
    {
      name: "transfer",
      template: "{from} sends {amount}",
      params: [
        { name: "from", type: "Address" },
        { name: "amount", type: "i128" },
      ],
    },
  ];

  beforeAll(async () => {
    await db.init();
    await db.query("DELETE FROM contracts WHERE id = $1", [contractId]);
    server = startApi();
  });

  afterAll(async () => {
    if (server?.close) await new Promise((resolve) => server.close(resolve));
  });

  it("returns 401 when PATCH is called without authentication", async () => {
    // Register first so the contract exists
    await request(server)
      .post("/api/contracts")
      .set("x-api-key", "admin-static-key")
      .send({
        id: contractId,
        name: "Ownership Test",
        functions: validFunctions,
      });

    // No x-api-key means this request isn't CSRF-exempt, so it needs a real
    // CSRF token/cookie pair to get past verifyCsrf and reach the route's
    // own auth check (otherwise it fails CSRF with 403 before that runs).
    const agent = request.agent(server);
    const { body: csrf } = await agent.get("/api/csrf-token");

    const res = await agent
      .patch(`/api/contracts/${contractId}`)
      .set("X-CSRF-Token", csrf.csrfToken)
      .send({ name: "Updated Name", functions: validFunctions });

    expect(res.status).toBe(401);
  });

  it("returns 404 when patching a non-existent contract", async () => {
    const res = await request(server)
      .patch("/api/contracts/CNONEXISTENT23AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
      .set("x-api-key", "admin-static-key")
      .send({ name: "Does not matter", functions: validFunctions });

    expect(res.status).toBe(404);
  });

  it("admin key can update any contract", async () => {
    const res = await request(server)
      .patch(`/api/contracts/${contractId}`)
      .set("x-api-key", "admin-static-key")
      .send({ name: "Admin Updated Name", functions: validFunctions });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
