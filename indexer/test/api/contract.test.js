import { jest } from "@jest/globals";
import fs from "fs";
import path from "path";
import yaml from "yaml";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import request from "supertest";

// Ensure process.env uses TEST_DATABASE_URL
const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/soroban_test";
process.env.DATABASE_URL = DB_URL;
process.env.API_KEY = "test-api-key";
process.env.VERIFY_ABI = "false";

const { db } = await import("../../src/db.js");
const { startApi } = await import("../../src/api.js");

// Load specification
const specPath = path.resolve(process.cwd(), "../docs/api/openapi.yaml");
const spec = yaml.parse(fs.readFileSync(specPath, "utf8"));

const ajv = new Ajv({
  allErrors: true,
  strict: false,
});
addFormats(ajv);

// Add all components schemas to AJV
if (spec.components && spec.components.schemas) {
  for (const [name, schema] of Object.entries(spec.components.schemas)) {
    ajv.addSchema(schema, `#/components/schemas/${name}`);
  }
}

function validateResponse(pathKey, method, statusCode, body) {
  const pathObj = spec.paths[pathKey];
  if (!pathObj) {
    throw new Error(`Path ${pathKey} not found in OpenAPI spec`);
  }
  const methodObj = pathObj[method.toLowerCase()];
  if (!methodObj) {
    throw new Error(`Method ${method} not found for path ${pathKey}`);
  }
  const responseObj = methodObj.responses[String(statusCode)];
  if (!responseObj) {
    throw new Error(`Status code ${statusCode} not documented for ${method.toUpperCase()} ${pathKey}`);
  }

  if (!responseObj.content) {
    return; // No body schema to validate (e.g. 204 or redirect)
  }

  const jsonContent = responseObj.content["application/json"];
  if (!jsonContent) {
    throw new Error(`No application/json content schema for ${method.toUpperCase()} ${pathKey} (${statusCode})`);
  }

  const schema = jsonContent.schema;
  const validate = ajv.compile(schema);
  const valid = validate(body);
  if (!valid) {
    console.error(`Validation errors for ${method.toUpperCase()} ${pathKey} (${statusCode}):`, validate.errors);
    throw new Error(`Response does not match OpenAPI schema: ${ajv.errorsText(validate.errors)}`);
  }
}

describe("OpenAPI Contract Validation Tests", () => {
  let app;
  let server;
  const wallet1 = "GBADY234567890123456789012345678901234567890123456789012";
  const wallet2 = "GBCUY234567890123456789012345678901234567890123456789012";

  beforeAll(async () => {
    // Initialize DB schema
    await db.init();

    // Clean tables
    await db.query(`
      TRUNCATE events, contracts, daemon_state, sandboxes, token_holders, privileged_roles, wasm_build_metadata, source_verifications, storage_state_diffs, sub_invocations RESTART IDENTITY CASCADE
    `);

    // Seed contracts
    await db.upsertContractMeta({
      id: "C1",
      name: "Contract One",
      description: "First contract details",
      functions: [{ name: "transfer", args: [] }],
      registered_by: "test-admin",
    });
    await db.upsertContractMeta({
      id: "C2",
      name: "Contract Two",
      description: "Second contract details",
      functions: [{ name: "mint", args: [] }],
      registered_by: "test-admin",
    });
    // Full-length strkey-format ID for the POST /api/contracts 409 test,
    // since that route validates `id` against the real strkey pattern.
    await db.upsertContractMeta({
      id: "CONEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      name: "Contract One (full ID)",
      description: "Seeded for the POST /api/contracts 409 test",
      functions: [{ name: "noop" }],
      registered_by: "test-admin",
    });

    // Seed events
    for (let i = 1; i <= 30; i++) {
      const contractId = i % 2 === 1 ? "C1" : "C2";
      const fn = i % 2 === 0 ? "transfer" : "mint";
      const ledger = 1000 + i;
      const txHash = `tx_hash_${i}`;
      const description = `Event ${i} on ${contractId} calling ${fn} involving ${wallet1} and ${wallet2}`;
      const rawTopics = [wallet1, wallet2];
      const rawData = JSON.stringify({ amount: String(100 * i) });

      await db.query(
        `INSERT INTO events (contract_id, function, ledger, tx_hash, description, raw_topics, raw_data)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [contractId, fn, ledger, txHash, description, JSON.stringify(rawTopics), rawData]
      );
    }

    // Start Express app
    server = startApi();
    app = server;
  });

  afterAll(async () => {
    if (server && server.close) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("should validate GET /health - 200 Response", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(() => validateResponse("/health", "GET", 200, res.body)).not.toThrow();
  });

  it("should validate GET /health - 503 Response", async () => {
    const originalQuery = db.query;
    db.query = jest.fn().mockRejectedValueOnce(new Error("DB Connection Error"));
    const res = await request(app).get("/health");
    expect(res.status).toBe(503);
    expect(() => validateResponse("/health", "GET", 503, res.body)).not.toThrow();
    db.query = originalQuery;
  });

  it("should validate GET /api/events - 200 Response", async () => {
    const res = await request(app).get("/api/events?page=1");
    expect(res.status).toBe(200);
    expect(() => validateResponse("/api/events", "GET", 200, res.body)).not.toThrow();
  });

  it("should validate GET /api/v1/events - 200 Response", async () => {
    const res = await request(app).get("/api/v1/events?limit=15");
    expect(res.status).toBe(200);
    expect(() => validateResponse("/api/v1/events", "GET", 200, res.body)).not.toThrow();
  });

  it("should validate GET /api/v1/events - 422 Response", async () => {
    const res = await request(app).get("/api/v1/events?limit=-5");
    expect(res.status).toBe(422);
    expect(() => validateResponse("/api/v1/events", "GET", 422, res.body)).not.toThrow();
  });

  it("should validate GET /api/events/{seq} - 200 Response", async () => {
    const res = await request(app).get("/api/events/5");
    expect(res.status).toBe(200);
    expect(() => validateResponse("/api/events/{seq}", "GET", 200, res.body)).not.toThrow();
  });

  it("should validate GET /api/events/{seq} - 404 Response", async () => {
    const res = await request(app).get("/api/events/9999");
    expect(res.status).toBe(404);
    expect(() => validateResponse("/api/events/{seq}", "GET", 404, res.body)).not.toThrow();
  });

  it("should validate GET /api/contracts/{id} - 200 Response", async () => {
    const res = await request(app).get("/api/contracts/C1");
    expect(res.status).toBe(200);
    expect(() => validateResponse("/api/contracts/{id}", "GET", 200, res.body)).not.toThrow();
  });

  it("should validate GET /api/contracts/{id} - 404 Response", async () => {
    const res = await request(app).get("/api/contracts/C9999");
    expect(res.status).toBe(404);
    expect(() => validateResponse("/api/contracts/{id}", "GET", 404, res.body)).not.toThrow();
  });

  it("should validate GET /api/contracts/{id}/stats - 200 Response", async () => {
    const res = await request(app).get("/api/contracts/C1/stats");
    expect(res.status).toBe(200);
    expect(() => validateResponse("/api/contracts/{id}/stats", "GET", 200, res.body)).not.toThrow();
  });

  it("should validate POST /api/contracts - 201 Response", async () => {
    const res = await request(app)
      .post("/api/contracts")
      .set("x-api-key", "test-api-key")
      .send({
        id: "CTHREEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        name: "Contract Three",
        description: "Third contract",
        functions: [{ name: "burn", description: "burn spec", args: [] }],
      });
    expect(res.status).toBe(201);
    expect(() => validateResponse("/api/contracts", "POST", 201, res.body)).not.toThrow();
  });

  it("should validate POST /api/contracts - 409 Response", async () => {
    const res = await request(app)
      .post("/api/contracts")
      .set("x-api-key", "test-api-key")
      .send({
        id: "CONEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        name: "Contract One",
        functions: [{ name: "noop" }],
      });
    expect(res.status).toBe(409);
    expect(() => validateResponse("/api/contracts", "POST", 409, res.body)).not.toThrow();
  });

  it("should validate POST /api/contracts - 400 Response", async () => {
    const res = await request(app)
      .post("/api/contracts")
      .set("x-api-key", "test-api-key")
      .send({
        id: "CFOURAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      });
    expect(res.status).toBe(400);
    expect(() => validateResponse("/api/contracts", "POST", 400, res.body)).not.toThrow();
  });

  it("should validate GET /api/wallet/{address} - 200 Response", async () => {
    // A well-formed but unseeded Stellar public key (G + 55 base32 chars).
    const validAddress = "G" + "A".repeat(55);
    const res = await request(app).get(`/api/wallet/${validAddress}`);
    expect(res.status).toBe(200);
    expect(() => validateResponse("/api/wallet/{address}", "GET", 200, res.body)).not.toThrow();
  });

  it("should validate GET /api/search - 200 Response", async () => {
    const res = await request(app).get("/api/search?q=transfer");
    expect(res.status).toBe(200);
    expect(() => validateResponse("/api/search", "GET", 200, res.body)).not.toThrow();
  });

  it("should validate GET /api/search - 400 Response", async () => {
    const res = await request(app).get("/api/search?q=");
    expect(res.status).toBe(400);
    expect(() => validateResponse("/api/search", "GET", 400, res.body)).not.toThrow();
  });

  it("should fail validation if response object is intentionally broken", () => {
    // Schema mismatch: DecodedEvent demands seq as integer, but we pass string
    const invalidMockBody = {
      seq: "NOT_AN_INTEGER",
      contract_id: "C1",
      function: "transfer",
      ledger: 1050,
      description: "invalid mock",
      raw_topics: [],
      raw_data: "{}",
      is_high_bloat_risk: false,
      is_clawback: false,
    };
    expect(() => validateResponse("/api/events/{seq}", "GET", 200, invalidMockBody)).toThrow();
  });
});
