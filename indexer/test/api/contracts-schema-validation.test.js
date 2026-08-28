/**
 * Issue #522: POST /api/contracts must validate the request body against
 * contractRegistry.schema.json using AJV.
 *
 * Acceptance criteria:
 *  - Submitting { id: 'C…', name: 'Test' } (missing functions) returns 400
 *    with { errors: [{ path: '/functions', message: 'required' }] }
 *  - A valid ABI returns 201
 */
import request from "supertest";

const DB_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  "postgres://postgres:postgres@localhost:5432/soroban_test";
process.env.DATABASE_URL = DB_URL;
process.env.API_KEY = "test-api-key";
process.env.VERIFY_ABI = "false";

const { db } = await import("../../src/db.js");
const { startApi } = await import("../../src/api.js");

describe("POST /api/contracts — ABI schema validation (issue #522)", () => {
  let server;
  const validId = "CSCHEMA522ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKABC";

  beforeAll(async () => {
    await db.init();
    await db.query("DELETE FROM contracts WHERE id = $1", [validId]);
    server = startApi();
  });

  afterAll(async () => {
    if (server?.close) await new Promise((resolve) => server.close(resolve));
  });

  it("returns 400 with structured errors when functions array is missing", async () => {
    const res = await request(server)
      .post("/api/contracts")
      .set("x-api-key", "test-api-key")
      .send({ id: validId, name: "Test" }); // no functions

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("errors");
    expect(Array.isArray(res.body.errors)).toBe(true);

    const functionsError = res.body.errors.find(
      (e) => e.path === "/functions" || e.path.includes("functions"),
    );
    expect(functionsError).toBeDefined();
    expect(functionsError.message).toMatch(/required/i);
  });

  it("returns 400 with path error when id is missing", async () => {
    const res = await request(server)
      .post("/api/contracts")
      .set("x-api-key", "test-api-key")
      .send({ name: "Test", functions: [] });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("errors");
    const idError = res.body.errors.find(
      (e) => e.path === "/id" || e.path.includes("id"),
    );
    expect(idError).toBeDefined();
  });

  it("returns 201 for a valid ABI payload", async () => {
    const res = await request(server)
      .post("/api/contracts")
      .set("x-api-key", "test-api-key")
      .send({
        id: validId,
        name: "Schema Validation Test",
        description: "Contract for issue #522 validation test",
        functions: [
          {
            name: "transfer",
            template: "{from} → {to}: {amount}",
            params: [
              { name: "from", type: "Address" },
              { name: "to", type: "Address" },
              { name: "amount", type: "i128" },
            ],
          },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true });
  });
});
