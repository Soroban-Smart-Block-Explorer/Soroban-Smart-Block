import { jest } from "@jest/globals";
import request from "supertest";
import pg from "pg";
import bcrypt from "bcryptjs";

// Ensure process.env uses TEST_DATABASE_URL
const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/soroban_test";
process.env.DATABASE_URL = DB_URL;
process.env.API_KEY = "test-api-key";
process.env.VERIFY_ABI = "false";

const { db } = await import("../../src/db.js");
const { startApi } = await import("../../src/api.js");

describe("REST API Integration Tests", () => {
  let app;
  let server;
  const wallet1 = "GBADY234567890123456789012345678901234567890123456789012";
  const wallet2 = "GBCUY234567890123456789012345678901234567890123456789012";

  beforeAll(async () => {
    // Initialize DB schema
    await db.init();

    // Clean tables to ensure isolation
    await db.query(`
      TRUNCATE events, contracts, daemon_state, sandboxes, token_holders, privileged_roles, wasm_build_metadata, source_verifications, storage_state_diffs, sub_invocations RESTART IDENTITY CASCADE
    `);

    // Seed 3 contracts
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
    await db.upsertContractMeta({
      id: "C3",
      name: "Contract Three",
      description: "Third contract details",
      functions: [],
      registered_by: "test-admin",
    });

    // Seed 50 events
    for (let i = 1; i <= 50; i++) {
      const contractId = i % 3 === 1 ? "C1" : i % 3 === 2 ? "C2" : "C3";
      const contract = req.query.contract?.trim();

if (
  contract &&
  !/^C[A-Z2-7]{55}$/.test(contract)
) {
  return res.status(400).json({
    error: "Invalid contract id",
  });
}
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

    await db.query(
      `INSERT INTO daemon_state (key, value)
       VALUES ('cursor', '1051'), ('last_indexed_ledger', '1050')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    );

    // Start Express app
    server = startApi();
    app = server;
  });

  afterAll(async () => {
    if (server && server.close) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  describe("GET /health", () => {
    it("should return 200 OK with comprehensive status when healthy", async () => {
      const res = await request(app).get("/health");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("status");
      expect(res.body).toHaveProperty("timestamp");
      expect(res.body).toHaveProperty("dependencies");
      expect(res.body.dependencies).toHaveProperty("database");
      expect(res.body.dependencies).toHaveProperty("cache");
      expect(res.body.dependencies).toHaveProperty("indexer");
      expect(res.body.dependencies).toHaveProperty("workers");
      expect(["healthy", "degraded"]).toContain(res.body.status);
    });

    it("should return 503 Service Unavailable when DB is failing", async () => {
      const originalQuery = db.query;
      db.query = jest.fn().mockRejectedValueOnce(new Error("DB Connection Error"));
      
      const res = await request(app).get("/health");
      expect(res.status).toBe(503);
      expect(res.body).toHaveProperty("status", "unhealthy");
      expect(res.body.dependencies.database.status).toBe("unhealthy");

      db.query = originalQuery;
    });
  });

  describe("GET /health/live", () => {
    it("should return 200 OK for liveness check", async () => {
      const res = await request(app).get("/health/live");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("status", "alive");
      expect(res.body).toHaveProperty("timestamp");
    });
  });

  describe("GET /health/ready", () => {
    it("should return 200 OK when service is ready", async () => {
      const res = await request(app).get("/health/ready");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("status", "ready");
      expect(res.body).toHaveProperty("timestamp");
      expect(res.body).toHaveProperty("dependencies");
    });

    it("should return 503 when service is not ready", async () => {
      const originalQuery = db.query;
      db.query = jest.fn().mockRejectedValueOnce(new Error("DB Connection Error"));
      
      const res = await request(app).get("/health/ready");
      expect(res.status).toBe(503);
      expect(res.body).toHaveProperty("status", "not_ready");
      expect(res.body).toHaveProperty("reason");

      db.query = originalQuery;
    });
  });

  describe("GET /api/admin/integrity", () => {
    const adminAuth = { Authorization: `Bearer ${process.env.ADMIN_SECRET || "test-admin-secret"}` };

    beforeAll(() => {
      process.env.ADMIN_SECRET = "test-admin-secret";
    });

    it("should return OK on a clean database", async () => {
      const res = await request(app).get("/api/admin/integrity").set(adminAuth);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it("should fail when a row is deleted and a seq gap appears", async () => {
      await db.query(`DELETE FROM events WHERE seq = 25`);

      const res = await request(app).get("/api/admin/integrity").set(adminAuth);

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(false);
      expect(Array.isArray(res.body.failed)).toBe(true);
      expect(res.body.failed.some((item) => item.check === "seq_gap")).toBe(true);

      await db.query(
        `INSERT INTO events (seq, contract_id, function, ledger, tx_hash, description, raw_topics, raw_data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          25,
          "C1",
          "mint",
          1025,
          "tx_hash_25_restored",
          "Event 25 restored",
          JSON.stringify([wallet1, wallet2]),
          JSON.stringify({ amount: "2500" }),
        ],
      );
    });
  });

  describe("API key daily usage enforcement", () => {
    const rawKey = "daily-limit-test-key-123";

    beforeAll(async () => {
      const keyHash = await bcrypt.hash(rawKey, 12);
      const { rows } = await db.query(
        `INSERT INTO api_keys
          (name, key_hash, key_prefix, tier, daily_limit, allowed_ips, allowed_endpoints, revoked, verified, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, TRUE, NULL)
         RETURNING id`,
        [
          "daily-limit-key",
          keyHash,
          rawKey.slice(0, 8),
          "free",
          2,
          JSON.stringify([]),
          JSON.stringify([]),
        ],
      );

      await db.query(
        `INSERT INTO api_key_usage (api_key_id, date, request_count)
         VALUES ($1, CURRENT_DATE, 0)
         ON CONFLICT (api_key_id, date)
         DO NOTHING`,
        [rows[0].id],
      );
    });

    it("should return 429 on the N+1 request once the daily limit is reached", async () => {
      const headers = { "x-api-key": rawKey, "X-Forwarded-For": "10.90.0.200" };

      const first = await request(app).get("/api/events?limit=1").set(headers);
      const second = await request(app).get("/api/events?limit=1").set(headers);
      const third = await request(app).get("/api/events?limit=1").set(headers);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(third.status).toBe(429);
      expect(third.body).toEqual({ error: "Daily API key usage limit exceeded" });
    });
  });

  describe("GET /api/events (Keyset cursor)", () => {
    // Each test uses a distinct X-Forwarded-For so the per-IP unauthenticated
    // rate-limit bucket (burst 10) is not shared with the rest of the suite.
    let ipCounter = 0;
    const getEvents = (url) => request(app).get(url).set("X-Forwarded-For", `10.90.0.${++ipCounter}`);

    it("should return { data, next_cursor } with default limit 25", async () => {
      const res = await getEvents("/api/events");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBe(25);
      expect(res.body.next_cursor).not.toBeNull();
    });

    it("should return null next_cursor when no further pages exist", async () => {
      const res = await getEvents("/api/events?limit=200");
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(50);
      expect(res.body.next_cursor).toBeNull();
    });

    it("should paginate correctly using next_cursor as after_seq", async () => {
      const res1 = await getEvents("/api/events?limit=30");
      expect(res1.status).toBe(200);
      expect(res1.body.data.length).toBe(30);
      const nextCursor = res1.body.next_cursor;
      expect(nextCursor).not.toBeNull();

      const res2 = await getEvents(`/api/events?limit=30&after_seq=${nextCursor}`);
      expect(res2.status).toBe(200);
      expect(res2.body.data.length).toBe(20);
      expect(res2.body.next_cursor).toBeNull();

      // No overlap: every seq on page 2 is below the cursor
      const maxPage2Seq = Math.max(...res2.body.data.map((e) => Number(e.seq)));
      expect(maxPage2Seq).toBeLessThan(Number(nextCursor));
    });

    it("should filter events by contract", async () => {
      const res = await getEvents("/api/events?contract=C1");
      expect(res.status).toBe(200);
      expect(res.body.data.every((ev) => ev.contract_id === "C1")).toBe(true);
    });

    it("should filter events by function name", async () => {
      const res = await getEvents("/api/events?fn=transfer");
      expect(res.status).toBe(200);
      expect(res.body.data.every((ev) => ev.function === "transfer")).toBe(true);
    });

    // Issue #555: the frontend's DEX function-filter chips pass a
    // comma-separated list of exact function names, e.g.
    // ?fn=swap,swap_exact_tokens_for_tokens.
    it("should filter events by a comma-separated list of function names", async () => {
      const res = await getEvents("/api/events?fn=mint,transfer&limit=50");
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(50);
      expect(res.body.data.every((ev) => ev.function === "mint" || ev.function === "transfer")).toBe(true);
    });

    it("should return no events for a function name that matches nothing", async () => {
      const res = await getEvents("/api/events?fn=nonexistent_fn");
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(0);
    });

    it("should return 422 for invalid limit values", async () => {
      const invalidLimits = ["-5", "0", "999", "abc"];
      for (const val of invalidLimits) {
        const res = await getEvents(`/api/events?limit=${val}`);
        expect(res.status).toBe(422);
        expect(res.body).toEqual({ error: "Invalid limit" });
      }
    });

    it("should return 422 for an invalid after_seq value", async () => {
      const res = await getEvents("/api/events?after_seq=abc");
      expect(res.status).toBe(422);
      expect(res.body).toEqual({ error: "Invalid after_seq" });
    });
  });

  describe("GET /api/v1/events (Cursor-based)", () => {
    it("should return specified limit of items on page 1", async () => {
      const res = await request(app).get("/api/v1/events?limit=20");
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(20);
      expect(res.body.next_cursor).toBeDefined();
    });

    it("should paginate correctly using the next_cursor", async () => {
      // Fetch Page 1
      const res1 = await request(app).get("/api/v1/events?limit=20");
      const nextCursor = res1.body.next_cursor;
      expect(nextCursor).not.toBeNull();

      // Fetch Page 2
      const res2 = await request(app).get(`/api/v1/events?limit=20&after=${nextCursor}`);
      expect(res2.status).toBe(200);
      expect(res2.body.data.length).toBe(20);
      
      // Ensure there is no overlap (elements on Page 2 have lower seq numbers)
      const maxPage2Seq = Math.max(...res2.body.data.map((e) => Number(e.seq)));
      expect(maxPage2Seq).toBeLessThan(Number(nextCursor));
    });

    it("should return 422 for invalid limit values", async () => {
      const invalidLimits = ["-5", "0", "999", "abc"];
      for (const val of invalidLimits) {
        const res = await request(app).get(`/api/v1/events?limit=${val}`);
        expect(res.status).toBe(422);
        expect(res.body).toEqual({ error: "Invalid limit" });
      }
    });
  });

  describe("GET /api/events/:seq", () => {
    it("should return the event details for a known sequence", async () => {
      const res = await request(app).get("/api/events/5");
      expect(res.status).toBe(200);
      expect(Number(res.body.seq)).toBe(5);
      expect(res.body.contract_id).toBeDefined();
    });

    it("should return a 404 RFC 7807 response for an unknown sequence", async () => {
      const res = await request(app).get("/api/events/9999");
      expect(res.status).toBe(404);
      expect(res.body).toEqual({
        type: "about:blank",
        title: "Not Found",
        status: 404,
        detail: "Event sequence 9999 not found",
      });
    });

    // Issue #554: slippage_bps is persisted and returned for DEX swap events.
    it("should include slippage_bps for a swap event that has it", async () => {
      await db.query(
        `INSERT INTO events (contract_id, function, ledger, tx_hash, description, raw_topics, raw_data, slippage_bps)
         VALUES ('C1', 'swap', 1099, 'tx_hash_slippage', 'Address GA… swapped 100 USDC → 99 XLM on StellarSwap (slippage: 1.00%)', '[]', '{}', 100)`,
      );

      const res = await request(app).get("/api/events?fn=swap&limit=200");
      expect(res.status).toBe(200);
      const withSlippage = res.body.data.find((ev) => ev.tx_hash === "tx_hash_slippage");
      expect(withSlippage).toBeDefined();
      expect(withSlippage.slippage_bps).toBe(100);
    });
  });

  // Issue #556: the frontend renders a protocol-type badge (DEX/Lending/NFT/
  // Token/Other) on contract cards, so the list endpoint must return it.
  describe("GET /api/contracts (list)", () => {
    beforeAll(async () => {
      await db.upsertContractMeta({
        id: "C_DEX_TEST",
        name: "Test DEX",
        description: "protocol_type badge fixture",
        functions: [{ name: "swap", args: [] }],
        registered_by: "test-admin",
      });
    });

    it("includes protocol_type for each contract", async () => {
      const res = await request(app).get("/api/contracts?limit=100");
      expect(res.status).toBe(200);
      const dex = res.body.contracts.find((c) => c.id === "C_DEX_TEST");
      expect(dex).toBeDefined();
      expect(dex.protocol_type).toBe("dex");
    });
  });

  describe("GET /api/contracts/:id", () => {
    it("should return contract metadata for a registered contract", async () => {
      const res = await request(app).get("/api/contracts/C1");
      expect(res.status).toBe(200);
      expect(res.body.id).toBe("C1");
      expect(res.body.name).toBe("Contract One");
    });

    it("should return 404 for an unknown contract ID", async () => {
      const res = await request(app).get("/api/contracts/C9999");
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "Not found" });
    });
  });

  describe("POST /api/contracts", () => {
    it("should register a new contract successfully", async () => {
      const res = await request(app)
        .post("/api/contracts")
        .set("x-api-key", "test-api-key")
        .send({
          id: "C4",
          name: "Contract Four",
          description: "Fourth contract details",
          functions: [{ name: "burn", args: [] }],
        });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ ok: true });
    });

    it("should return 409 Conflict if registering an already existing contract", async () => {
      const res = await request(app)
        .post("/api/contracts")
        .set("x-api-key", "test-api-key")
        .send({
          id: "C1",
          name: "Contract One Dupe",
          functions: [],
        });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: "Contract already exists" });
    });

    it("should return 400 Bad Request if request body is invalid", async () => {
      const res = await request(app)
        .post("/api/contracts")
        .set("x-api-key", "test-api-key")
        .send({
          id: "C5",
          // missing functions
        });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "Missing id or functions" });
    });
  });

  describe("GET /api/wallet/:address", () => {
    // A well-formed but unseeded Stellar public key (G + 55 base32 chars).
    const validAddress = "G" + "A".repeat(55);

    it("should return 200 with an events array for a valid address", async () => {
      const res = await request(app).get(`/api/wallet/${validAddress}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.events)).toBe(true);
    });

    it("should return 400 for a malformed address", async () => {
      const res = await request(app).get("/api/wallet/not-a-valid-address");
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/events — keyset pagination over 500 events (#490)", () => {
    // Distinct contract id so these events (and their cache keys) don't
    // collide with the 50 events seeded for the earlier tests.
    const PAGINATION_CONTRACT = "CPAGINATION";

    beforeAll(async () => {
      const values = [];
      const params = [];
      for (let i = 1; i <= 500; i++) {
        const base = params.length;
        params.push(PAGINATION_CONTRACT, "transfer", 5000 + i, `pagination_tx_${i}`, `Pagination event ${i}`, "[]", "{}");
        values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`);
      }
      await db.query(
        `INSERT INTO events (contract_id, function, ledger, tx_hash, description, raw_topics, raw_data)
         VALUES ${values.join(", ")}`,
        params,
      );
    });

    it("returns all 500 events exactly once across pages of 25", async () => {
      const seenSeqs = [];
      let after = null;
      let pages = 0;

      do {
        const url =
          after === null
            ? `/api/events?contract=${PAGINATION_CONTRACT}&limit=25`
            : `/api/events?contract=${PAGINATION_CONTRACT}&limit=25&after_seq=${after}`;
        // Unique client IP per request so the per-IP unauthenticated
        // rate-limit bucket (burst 10) never throttles the pagination walk.
        const res = await request(app).get(url).set("X-Forwarded-For", `10.91.0.${pages + 1}`);
        expect(res.status).toBe(200);
        expect(res.body.data.length).toBeLessThanOrEqual(25);
        for (const ev of res.body.data) seenSeqs.push(Number(ev.seq));
        after = res.body.next_cursor;
        pages++;
        // Safety guard against an infinite pagination loop
        expect(pages).toBeLessThanOrEqual(21);
      } while (after !== null);

      expect(pages).toBe(20);
      expect(seenSeqs.length).toBe(500);
      expect(new Set(seenSeqs).size).toBe(500);
    });
  });
});
