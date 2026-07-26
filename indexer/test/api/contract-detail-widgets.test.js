import request from "supertest";

// Ensure process.env uses TEST_DATABASE_URL
const DB_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  "postgres://postgres:postgres@localhost:5432/soroban_test";
process.env.DATABASE_URL = DB_URL;
process.env.API_KEY = "test-api-key";
process.env.VERIFY_ABI = "false";

const { db } = await import("../../src/db.js");
const { startApi } = await import("../../src/api.js");

// Covers the four contract-detail-page widgets:
//   #537 GET /api/contracts/:id/wasm
//   #538 GET /api/contracts/:id/upgrades
//   #539 GET /api/contracts/:id/circuit-breaker
//   #540 GET /api/contracts/:id/call-graph
describe("Contract detail widget endpoints", () => {
  let app;
  let server;

  beforeAll(async () => {
    await db.init();

    await db.query(`
      TRUNCATE events, contracts, wasm_build_metadata, sub_invocations RESTART IDENTITY CASCADE
    `);

    await db.upsertContractMeta({
      id: "CDEX",
      name: "DEX Contract",
      description: "Swaps tokens",
      functions: [{ name: "swap", args: [] }],
      registered_by: "test-admin",
      has_circuit_breaker: true,
    });
    await db.upsertContractMeta({
      id: "CTOKEN",
      name: "Token Contract",
      description: "SEP-41 token",
      functions: [{ name: "transfer", args: [] }],
      registered_by: "test-admin",
    });
    await db.upsertContractMeta({
      id: "CPLAIN",
      name: "Plain Contract",
      description: "No circuit breaker, no wasm, no upgrades",
      functions: [{ name: "noop", args: [] }],
      registered_by: "test-admin",
    });

    server = startApi();
    app = server;
  });

  afterAll(async () => {
    if (server && server.close) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  describe("GET /api/contracts/:id/wasm (#537)", () => {
    it("returns 404 with a 'WASM not indexed' message when no build metadata exists", async () => {
      const res = await request(app).get("/api/contracts/CPLAIN/wasm");
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/WASM not indexed/i);
    });

    it("returns hash, compiler, SDK version, and size once indexed", async () => {
      await db.upsertWasmBuildMetadata({
        wasm_hash: "a".repeat(64),
        contract_id: "CDEX",
        size_bytes: 54321,
        sdk_version: "v21.1.0",
        compiler: "rustc 1.78.0",
        optimizer: "wasm-opt 116",
        repository: null,
        commit: null,
        producers: { language: "Rust 1.78.0" },
        ledger: 1000,
        tx_hash: "wasm_tx_1",
      });

      const res = await request(app).get("/api/contracts/CDEX/wasm");
      expect(res.status).toBe(200);
      expect(res.body.wasm_hash).toBe("a".repeat(64));
      expect(res.body.compiler).toBe("rustc 1.78.0");
      expect(res.body.sdk_version).toBe("v21.1.0");
      expect(Number(res.body.size_bytes)).toBe(54321);
    });
  });

  describe("GET /api/contracts/:id/upgrades (#538)", () => {
    it("returns an empty array when the contract has never been upgraded", async () => {
      const res = await request(app).get("/api/contracts/CPLAIN/upgrades");
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("returns two upgrade entries in chronological order for a contract upgraded twice", async () => {
      await db.query(
        `INSERT INTO events (contract_id, function, ledger, tx_hash, description, raw_topics, raw_data, upgrade_info)
         VALUES
           ($1, 'upgrade', 2000, 'up_tx_1', 'first upgrade', '[]', '{}', $2),
           ($1, 'upgrade', 3000, 'up_tx_2', 'second upgrade', '[]', '{}', $3)`,
        [
          "CDEX",
          JSON.stringify({ type: "upgrade", oldHash: "hash_v1", newHash: "hash_v2" }),
          JSON.stringify({ type: "upgrade", oldHash: "hash_v2", newHash: "hash_v3" }),
        ],
      );

      const res = await request(app).get("/api/contracts/CDEX/upgrades");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(res.body[0]).toMatchObject({ ledger: 2000, old_hash: "hash_v1", new_hash: "hash_v2" });
      expect(res.body[1]).toMatchObject({ ledger: 3000, old_hash: "hash_v2", new_hash: "hash_v3" });
      expect(res.body[0].ledger).toBeLessThan(res.body[1].ledger);
    });
  });

  describe("GET /api/contracts/:id/circuit-breaker (#539)", () => {
    it("hides breaker fields with has_circuit_breaker=false for a plain contract", async () => {
      const res = await request(app).get("/api/contracts/CPLAIN/circuit-breaker");
      expect(res.status).toBe(200);
      expect(res.body.has_circuit_breaker).toBe(false);
      expect(res.body.status).toBe("CLOSED");
    });

    it("reports OPEN status with the triggering event's ledger, tx hash, and seq", async () => {
      const insertRes = await db.query(
        `INSERT INTO events (contract_id, function, ledger, tx_hash, description, raw_topics, raw_data)
         VALUES ('CDEX', 'pause', 4000, 'pause_tx_1', 'emergency pause', '[]', '{}')
         RETURNING seq`,
      );
      const triggerSeq = insertRes.rows[0].seq;

      await db.updateCircuitBreakerStatus("CDEX", true, 4000, "pause_tx_1");

      const res = await request(app).get("/api/contracts/CDEX/circuit-breaker");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("OPEN");
      expect(res.body.is_paused).toBe(true);
      expect(res.body.pause_trigger_tx_hash).toBe("pause_tx_1");
      expect(Number(res.body.pause_trigger_event_seq)).toBe(Number(triggerSeq));
    });

    it("clears trigger fields once the breaker is reset to CLOSED", async () => {
      await db.updateCircuitBreakerStatus("CDEX", false, 4100, null);
      const res = await request(app).get("/api/contracts/CDEX/circuit-breaker");
      expect(res.body.status).toBe("CLOSED");
      expect(res.body.pause_trigger_tx_hash).toBeNull();
      expect(res.body.pause_trigger_event_seq).toBeNull();
    });
  });

  describe("GET /api/contracts/:id/call-graph (#540)", () => {
    it("returns an empty graph when no sub-invocations were recorded", async () => {
      const res = await request(app).get("/api/contracts/CPLAIN/call-graph");
      expect(res.status).toBe(200);
      expect(res.body.nodes).toEqual([]);
      expect(res.body.edges).toEqual([]);
    });

    it("shows an edge to the token contract with the call count for a DEX that swaps repeatedly", async () => {
      await db.query(
        `INSERT INTO events (contract_id, function, ledger, tx_hash, description, raw_topics, raw_data)
         VALUES
           ('CDEX', 'swap', 5000, 'swap_tx_1', 'swap 1', '[]', '{}'),
           ('CDEX', 'swap', 5001, 'swap_tx_2', 'swap 2', '[]', '{}'),
           ('CDEX', 'swap', 5002, 'swap_tx_3', 'swap 3', '[]', '{}')`,
      );
      await db.upsertSubInvocations([
        {
          parent_tx_hash: "swap_tx_1",
          depth: 1,
          contract_id: "CTOKEN",
          function: "transfer",
          args: null,
          ledger: 5000,
        },
        {
          parent_tx_hash: "swap_tx_2",
          depth: 1,
          contract_id: "CTOKEN",
          function: "transfer",
          args: null,
          ledger: 5001,
        },
        {
          parent_tx_hash: "swap_tx_3",
          depth: 1,
          contract_id: "CTOKEN",
          function: "transfer",
          args: null,
          ledger: 5002,
        },
      ]);

      const res = await request(app).get("/api/contracts/CDEX/call-graph");
      expect(res.status).toBe(200);
      expect(res.body.nodes).toEqual(
        expect.arrayContaining([
          { id: "CDEX", label: "CDEX", type: "contract" },
          { id: "CTOKEN", label: "CTOKEN", type: "contract" },
        ]),
      );
      expect(res.body.edges).toHaveLength(1);
      expect(res.body.edges[0]).toMatchObject({ source: "CDEX", target: "CTOKEN", call_count: 3 });
    });
  });
});
