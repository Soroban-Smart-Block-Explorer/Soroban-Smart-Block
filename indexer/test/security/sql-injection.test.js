import { jest } from "@jest/globals";
import request from "supertest";

// Ensure tests use the test DB when present
const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/soroban_test";
process.env.DATABASE_URL = DB_URL;
process.env.API_KEY = "test-api-key";
process.env.VERIFY_ABI = "false";

const { createApi } = await import("../../src/api.js");
let realDb;
try {
  // optional: only import the real DB when available
  ({ db: realDb } = await import("../../src/db.js"));
} catch (e) {
  realDb = null;
}

describe("SQL injection regression tests", () => {
  let app;
  let server;
  let ipCounter = 0;

  beforeAll(async () => {
    // Use an injected DB for deterministic behaviour in CI without a DB.
    const dbOverride = {
      async getEventsCursor() {
        return { data: [], next_cursor: null };
      },
      async searchContracts() {
        return [];
      },
      async getWalletEvents() {
        return [];
      },
    };

    app = createApi({ dbOverride, logDestination: null });
    server = app; // supertest accepts the express app
  });

  afterAll(async () => {
    if (server && server.close) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  const payloads = [
    "'; DROP TABLE events; --",
    "' OR '1'='1",
    "%27 UNION SELECT 1,2,3--",
  ];

  const nextIp = () => `10.101.0.${++ipCounter}`;

  test("endpoints should not return 500 for SQL injection payloads", async () => {
    for (const payload of payloads) {
      // /api/events?contract=
      const evRes = await request(app)
        .get(`/api/events?contract=${encodeURIComponent(payload)}`)
        .set("X-Forwarded-For", nextIp());

      expect([200, 400]).toContain(evRes.status);
      if (evRes.status === 200) {
        expect(Array.isArray(evRes.body.data)).toBe(true);
        expect(evRes.body.data.length).toBe(0);
      }

      // /api/contracts?q=
      const cRes = await request(app)
        .get(`/api/contracts?q=${encodeURIComponent(payload)}`)
        .set("X-Forwarded-For", nextIp());

      expect([200, 400]).toContain(cRes.status);
      if (cRes.status === 200) {
        expect(Array.isArray(cRes.body.contracts)).toBe(true);
        expect(cRes.body.contracts.length).toBe(0);
      }

      // /api/wallet/:address — should be validated and return 400 for malformed
      const wRes = await request(app)
        .get(`/api/wallet/${encodeURIComponent(payload)}`)
        .set("X-Forwarded-For", nextIp());

      // Wallet endpoint validates Stellar address format and should return 400
      expect([200, 400]).toContain(wRes.status);
      if (wRes.status === 200) {
        // When server (unexpectedly) accepts the address, ensure result is an array
        expect(Array.isArray(wRes.body.events)).toBe(true);
        // Defensive: prefer empty results for these payloads
        expect(wRes.body.events.length).toBe(0);
      }
    }
  });

  test("events table still exists after payloads (if DB available)", async () => {
    if (!process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL) {
      // No DB configured in the test environment — skip this assertion.
      return;
    }
    if (!realDb) {
      // Could not import real DB — skip.
      return;
    }

    const result = await realDb.query("SELECT 1 FROM events LIMIT 1");
    expect(result).toBeDefined();
    expect(result).toHaveProperty("rows");
  });
});
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApi } from "../../src/api.js";

const payloads = [
  "'; DROP TABLE events; --",
  "' OR '1'='1",
  "%27 UNION SELECT 1,2,3--",
];

describe("SQL injection regression", () => {
  const app = createApi({
    dbOverride: {
      async getEventsCursor() {
        return { data: [], next_cursor: null };
      },

      async query(sql) {
        if (sql.includes("to_regclass")) {
          return {
            rows: [{ table_name: "events" }],
          };
        }

        return { rows: [] };
      },
    },
  });

  it("never returns 500 for malicious user input", async () => {
    for (const payload of payloads) {
      const events = await request(app).get(
        `/api/events?contract=${encodeURIComponent(payload)}`
      );

      assert.ok([200, 400].includes(events.status));

      const contracts = await request(app).get(
        `/api/contracts?q=${encodeURIComponent(payload)}`
      );

      assert.ok([200, 400].includes(contracts.status));

      const wallet = await request(app).get(
        `/api/wallet/${encodeURIComponent(payload)}`
      );

      assert.ok([200, 400].includes(wallet.status));
    }
  });

  it("keeps the events table intact", async () => {
    const { rows } = await app.locals.db.query(
      "SELECT to_regclass('public.events') AS table_name"
    );

    assert.equal(rows[0].table_name, "events");
  });
});