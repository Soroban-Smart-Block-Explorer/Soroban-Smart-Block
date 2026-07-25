import fs from "fs";
import path from "path";
import yaml from "yaml";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import request from "supertest";

// Issue #541 — GET /api/contracts/:id/stats
// Issue #543 — GET /api/contracts/:id/storage-tiers

const DB_URL =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/soroban_test";
process.env.DATABASE_URL = DB_URL;

const { db } = await import("../../src/db.js");
const { startApi } = await import("../../src/api.js");

const specPath = path.resolve(process.cwd(), "../docs/api/openapi.yaml");
const spec = yaml.parse(fs.readFileSync(specPath, "utf8"));
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
for (const [name, schema] of Object.entries(spec.components.schemas)) {
  ajv.addSchema(schema, `#/components/schemas/${name}`);
}

function validateAgainstSchema(schemaName, body) {
  const validate = ajv.compile({ $ref: `#/components/schemas/${schemaName}` });
  const valid = validate(body);
  if (!valid) {
    throw new Error(`Response does not match ${schemaName}: ${ajv.errorsText(validate.errors)}`);
  }
}

describe("Contract stats and storage-tier endpoints", () => {
  let server;

  beforeAll(async () => {
    await db.init();
    await db.query(
      `TRUNCATE events, contracts, daemon_state RESTART IDENTITY CASCADE`,
    );

    await db.upsertContractMeta({
      id: "CSTATS1",
      name: "Stats Contract",
      description: "Contract used for stats endpoint tests",
      functions: [],
      registered_by: "test-admin",
    });

    // 5 events, 3 distinct callers, one caller repeated (2 events), spanning ledgers 100..104.
    const callers = ["GCALLER1", "GCALLER2", "GCALLER1", "GCALLER3", null];
    for (let i = 0; i < callers.length; i++) {
      await db.query(
        `INSERT INTO events (contract_id, function, ledger, tx_hash, description, caller_address)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ["CSTATS1", "transfer", 100 + i, `tx_stats_${i}`, `Stats event ${i}`, callers[i]],
      );
    }

    // Storage-tier events for a separate contract: 2 persistent, 1 temporary, 1 instance write.
    await db.upsertContractMeta({
      id: "CTIERS1",
      name: "Tiers Contract",
      description: "Contract used for storage-tier endpoint tests",
      functions: [],
      registered_by: "test-admin",
    });
    const tierRows = [
      {
        persistent: [{ tier: "persistent", contractId: "CTIERS1", key: "a", changeType: "created" }],
        temporary: [{ tier: "temporary", contractId: "CTIERS1", key: "b", changeType: "created" }],
        instance: [],
      },
      {
        persistent: [{ tier: "persistent", contractId: "CTIERS1", key: "c", changeType: "updated" }],
        temporary: [],
        instance: [{ tier: "instance", contractId: "CTIERS1", key: "ContractInstance", changeType: "updated" }],
      },
    ];
    for (let i = 0; i < tierRows.length; i++) {
      await db.query(
        `INSERT INTO events (contract_id, function, ledger, tx_hash, description, storage_tiers)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ["CTIERS1", "set", 200 + i, `tx_tiers_${i}`, `Tier event ${i}`, JSON.stringify(tierRows[i])],
      );
    }

    // Dedicated contract for the caching assertion below so it isn't affected
    // by cache state left over from other tests hitting the same key.
    await db.upsertContractMeta({
      id: "CCACHECHECK",
      name: "Cache Check Contract",
      description: "Contract used only to assert cache HIT/MISS behavior",
      functions: [],
      registered_by: "test-admin",
    });
    await db.query(
      `INSERT INTO events (contract_id, function, ledger, tx_hash, description)
       VALUES ($1, $2, $3, $4, $5)`,
      ["CCACHECHECK", "transfer", 300, "tx_cache_check", "Cache check event"],
    );

    server = startApi();
  });

  afterAll(async () => {
    if (server && server.close) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  describe("GET /api/contracts/:id/stats", () => {
    it("returns total events, unique callers, and ledger range", async () => {
      const res = await request(server).get("/api/contracts/CSTATS1/stats");
      expect(res.status).toBe(200);
      validateAgainstSchema("ContractStats", res.body);

      expect(res.body.total_events).toBe(5);
      expect(res.body.unique_callers).toBe(3); // GCALLER1, GCALLER2, GCALLER3 (null excluded)
      expect(res.body.first_seen_ledger).toBe(100);
      expect(res.body.last_seen_ledger).toBe(104);
    });

    it("returns a 30-entry events_per_day series ordered oldest-first", async () => {
      const res = await request(server).get("/api/contracts/CSTATS1/stats");
      expect(res.status).toBe(200);
      expect(res.body.events_per_day).toHaveLength(30);
      const dates = res.body.events_per_day.map((d) => d.date);
      const sorted = [...dates].sort();
      expect(dates).toEqual(sorted);
      // All seeded events use NOW() as created_at, so today's bucket carries the count.
      const today = res.body.events_per_day[res.body.events_per_day.length - 1];
      expect(today.count).toBe(5);
    });

    it("returns zeroed stats for a contract with no events", async () => {
      const res = await request(server).get("/api/contracts/CNOEVENTS/stats");
      expect(res.status).toBe(200);
      validateAgainstSchema("ContractStats", res.body);
      expect(res.body).toMatchObject({
        total_events: 0,
        unique_callers: 0,
        first_seen_ledger: null,
        last_seen_ledger: null,
      });
      expect(res.body.events_per_day.every((d) => d.count === 0)).toBe(true);
    });

    it("serves the second request from cache (X-Cache: HIT)", async () => {
      const first = await request(server).get("/api/contracts/CCACHECHECK/stats");
      expect(first.headers["x-cache"]).toBe("MISS");
      const second = await request(server).get("/api/contracts/CCACHECHECK/stats");
      expect(second.headers["x-cache"]).toBe("HIT");
      expect(second.headers["cache-control"]).toContain("max-age=300");
    });
  });

  describe("GET /api/contracts/:id/storage-tiers", () => {
    it("aggregates write counts per storage durability tier", async () => {
      const res = await request(server).get("/api/contracts/CTIERS1/storage-tiers");
      expect(res.status).toBe(200);
      validateAgainstSchema("StorageTierCounts", res.body);
      expect(res.body).toEqual({ temporary: 1, persistent: 2, instance: 1 });
    });

    it("renders gracefully (all zero) for a contract with no storage writes", async () => {
      const res = await request(server).get("/api/contracts/CNOEVENTS/storage-tiers");
      expect(res.status).toBe(200);
      validateAgainstSchema("StorageTierCounts", res.body);
      expect(res.body).toEqual({ temporary: 0, persistent: 0, instance: 0 });
    });
  });
});
