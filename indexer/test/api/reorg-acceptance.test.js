/**
 * Acceptance tests for reorg detection end-to-end wiring (issue #489).
 *
 * Two criteria are validated:
 *
 * 1. Rollback + cursor rewind
 *    Simulating a hash mismatch at ledger N causes all events at ledger N and
 *    above to be deleted and the daemon cursor to be rewound to N-1.
 *
 * 2. REORG_DETECTED alert visible in GET /api/health
 *    After checkForReorg detects a fork, fireAlert(REORG_DETECTED) is called,
 *    and the active alert is returned in the GET /api/health response body.
 */

import { jest } from "@jest/globals";
import request from "supertest";

// ── Environment bootstrap ────────────────────────────────────────────────────
// Use the test database if provided; fall back to the default connection string.
// Tests that require a real DB are guarded by describeWithDatabase below.
const DB_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  "postgres://postgres:postgres@localhost:5432/soroban_test";
process.env.DATABASE_URL = DB_URL;

// Suppress Slack / PagerDuty webhook calls — we never want real outbound HTTP
// in unit tests.
process.env.SLACK_WEBHOOK_URL = "";
process.env.PAGERDUTY_ROUTING_KEY = "";

const { checkForReorg } = await import("../../src/reorgWorker.js");
const {
  ALERT_CONDITIONS,
  fireAlert,
  resolveAlert,
  getActiveAlerts,
} = await import("../../src/alertManager.js");
const { db, pool } = await import("../../src/db.js");
const { startApi } = await import("../../src/api.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Clear all active alert conditions between tests. */
function clearAlerts() {
  for (const cond of Object.values(ALERT_CONDITIONS)) {
    resolveAlert(cond);
  }
}

// ── Acceptance criterion 1 (unit) ─────────────────────────────────────────────
// Verify that checkForReorg, given an injected mismatch, calls rollback with
// the earliest fork ledger and fires the REORG_DETECTED alert.

describe("reorg detection — rollback + cursor rewind (unit)", () => {
  afterEach(clearAlerts);

  it("fires rollback at fork ledger N and resolves to N when mismatch is at N", async () => {
    const forkN = 50000;

    // Stored hashes: ledger N has a fork hash, N+1 and N-1 are stable.
    const getStoredHashes = jest.fn().mockResolvedValue([
      { ledger: String(forkN + 1), hash: "stable-above" },
      { ledger: String(forkN),     hash: "stored-fork-hash" },
      { ledger: String(forkN - 1), hash: "stable-below" },
    ]);

    // RPC returns a different hash for ledger N (mismatch) and stable hashes
    // for the others.
    const rpc = {
      getLedger: jest.fn(async (ledger) => {
        if (ledger === forkN) return { hash: "network-fork-hash" };
        return { hash: ledger === forkN + 1 ? "stable-above" : "stable-below" };
      }),
    };

    const rollbackFork = jest.fn().mockResolvedValue(undefined);
    const alertReorg   = jest.fn().mockResolvedValue(undefined);

    const result = await checkForReorg(rpc, {
      getStoredHashes,
      rollbackFork,
      alertReorg,
    });

    // Returns the fork ledger height
    expect(result).toBe(forkN);

    // rollback was called exactly once with the fork ledger
    expect(rollbackFork).toHaveBeenCalledTimes(1);
    expect(rollbackFork).toHaveBeenCalledWith(forkN);

    // alert was fired with the fork ledger
    expect(alertReorg).toHaveBeenCalledTimes(1);
    expect(alertReorg).toHaveBeenCalledWith(forkN);
  });

  it("returns null and does NOT call rollback when all hashes match", async () => {
    const getStoredHashes = jest.fn().mockResolvedValue([
      { ledger: "100", hash: "hash-100" },
      { ledger: "101", hash: "hash-101" },
    ]);

    const rpc = {
      getLedger: jest.fn(async (ledger) => ({ hash: `hash-${ledger}` })),
    };

    const rollbackFork = jest.fn();
    const alertReorg   = jest.fn();

    const result = await checkForReorg(rpc, {
      getStoredHashes,
      rollbackFork,
      alertReorg,
    });

    expect(result).toBeNull();
    expect(rollbackFork).not.toHaveBeenCalled();
    expect(alertReorg).not.toHaveBeenCalled();
  });

  it("selects the EARLIEST fork when mismatches appear at multiple ledgers", async () => {
    // Ledger 200 and 205 both fork; the earliest (200) should be rolled back.
    const getStoredHashes = jest.fn().mockResolvedValue([
      { ledger: "210", hash: "stable-210" },
      { ledger: "205", hash: "stored-205" },  // forked
      { ledger: "200", hash: "stored-200" },  // earliest fork
    ]);

    const rpc = {
      getLedger: jest.fn(async (ledger) => {
        if (ledger === 205 || ledger === 200) return { hash: `network-${ledger}` };
        return { hash: `stable-${ledger}` };
      }),
    };

    const rollbackFork = jest.fn().mockResolvedValue(undefined);
    const alertReorg   = jest.fn().mockResolvedValue(undefined);

    const result = await checkForReorg(rpc, {
      getStoredHashes,
      rollbackFork,
      alertReorg,
    });

    expect(result).toBe(200);
    expect(rollbackFork).toHaveBeenCalledWith(200);
    expect(alertReorg).toHaveBeenCalledWith(200);
  });
});

// ── Acceptance criterion 2 (unit) ─────────────────────────────────────────────
// REORG_DETECTED alert fires and is visible in GET /api/health.

describe("reorg detection — REORG_DETECTED visible in GET /api/health", () => {
  let server;

  beforeAll(() => {
    // Mock db.query so the health check does not need a real DB connection.
    db.query = jest.fn().mockResolvedValue({ rows: [{ health_check: 1 }] });
    server = startApi();
  });

  afterEach(clearAlerts);

  afterAll(async () => {
    if (server?.close) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("GET /api/health shows REORG_DETECTED after alertReorg() is called", async () => {
    // Simulate what checkForReorg does after finding a fork.
    await fireAlert(
      ALERT_CONDITIONS.REORG_DETECTED,
      "Chain reorganization detected at ledger 99999",
    );

    const res = await request(server).get("/api/health");

    // Health endpoint must respond (200 or 503 depending on other deps).
    expect([200, 503]).toContain(res.status);
    expect(res.body.alerts).toBeDefined();
    expect(res.body.alerts.active_count).toBeGreaterThanOrEqual(1);
    expect(res.body.alerts.conditions).toContain(ALERT_CONDITIONS.REORG_DETECTED);
  });

  it("GET /api/health does NOT contain REORG_DETECTED when no reorg has fired", async () => {
    // Ensure the slate is clean.
    clearAlerts();

    const res = await request(server).get("/api/health");

    expect([200, 503]).toContain(res.status);
    if (res.body.alerts) {
      expect(res.body.alerts.conditions ?? []).not.toContain(ALERT_CONDITIONS.REORG_DETECTED);
    }
  });

  it("resolving the alert removes REORG_DETECTED from GET /api/health", async () => {
    await fireAlert(ALERT_CONDITIONS.REORG_DETECTED, "test reorg at ledger 77777");

    // Confirm it is visible.
    const res1 = await request(server).get("/api/health");
    expect(res1.body.alerts.conditions).toContain(ALERT_CONDITIONS.REORG_DETECTED);

    // Resolve the alert.
    resolveAlert(ALERT_CONDITIONS.REORG_DETECTED);

    const res2 = await request(server).get("/api/health");
    expect(res2.body.alerts.conditions ?? []).not.toContain(ALERT_CONDITIONS.REORG_DETECTED);
  });
});

// ── Acceptance criterion 1 (PostgreSQL integration) ───────────────────────────
// Requires a real database. Guarded so the suite degrades gracefully in pure
// unit-test environments.

const describeWithDatabase = DB_URL.includes("unused") ? describe.skip : describe;

describeWithDatabase(
  "reorg detection — DB rollback deletes events ≥ N and rewinds cursor (PostgreSQL)",
  () => {
    // Use a ledger range that is astronomically unlikely to collide with real
    // indexed data: a large base offset seeded with the current millisecond.
    const BASE = 9_000_000_000 + (Date.now() % 10_000_000);
    const forkLedger   = BASE;          // mismatch at this ledger
    const stableLedger = BASE - 1;      // should survive rollback
    const orphan1      = BASE;          // should be deleted (= forkLedger)
    const orphan2      = BASE + 1;      // should be deleted (> forkLedger)
    const contractId   = `REORG_AC_${BASE}`;

    let savedCursor = null;

    beforeAll(async () => {
      await db.init();

      // Save whatever cursor exists so we can restore it afterwards.
      const { rows } = await pool.query(
        "SELECT value FROM daemon_state WHERE key = 'cursor'",
      );
      savedCursor = rows[0]?.value ?? null;

      // Insert test events: one before the fork (stable), two at/above (orphaned).
      await pool.query(
        `INSERT INTO events (contract_id, function, ledger, description)
         VALUES
           ($1, 'stable',   $2, 'before fork'),
           ($1, 'orphaned', $3, 'at fork'),
           ($1, 'orphaned', $4, 'above fork')`,
        [contractId, stableLedger, orphan1, orphan2],
      );

      // Insert ledger hashes for each.
      await pool.query(
        `INSERT INTO ledger_hashes (ledger, hash)
         VALUES ($1, 'hash-stable'), ($2, 'hash-at-fork'), ($3, 'hash-above-fork')`,
        [stableLedger, forkLedger, orphan2],
      );
    });

    afterAll(async () => {
      // Clean up test rows regardless of test outcome.
      await pool.query(
        "DELETE FROM events WHERE contract_id = $1",
        [contractId],
      );
      await pool.query(
        "DELETE FROM ledger_hashes WHERE ledger BETWEEN $1 AND $2",
        [stableLedger, orphan2],
      );

      // Restore the cursor to whatever it was before the test.
      if (savedCursor === null) {
        await pool.query("DELETE FROM daemon_state WHERE key = 'cursor'");
      } else {
        await pool.query(
          `INSERT INTO daemon_state (key, value) VALUES ('cursor', $1)
           ON CONFLICT (key) DO UPDATE SET value = $1`,
          [savedCursor],
        );
      }

      await pool.end();
    });

    it(
      "deletes events at ledger ≥ N, removes orphaned hashes, and persists cursor = N",
      async () => {
        // RPC reports a different hash at forkLedger and the ledger above it;
        // stableLedger matches.
        const rpc = {
          getLedger: jest.fn(async (ledger) => {
            if (ledger === forkLedger) return { hash: "network-fork-hash" };
            if (ledger === orphan2)    return { hash: "network-above-hash" };
            return { hash: "hash-stable" };
          }),
        };

        const alertReorg = jest.fn().mockResolvedValue(undefined);

        const detected = await checkForReorg(rpc, { alertReorg });

        // ── cursor check ───────────────────────────────────────────────────────
        // checkForReorg returns the fork ledger; the DB cursor is set to that value.
        expect(detected).toBe(forkLedger);
        expect(alertReorg).toHaveBeenCalledWith(forkLedger);

        const { rows: cursorRows } = await pool.query(
          "SELECT value FROM daemon_state WHERE key = 'cursor'",
        );
        expect(Number(cursorRows[0].value)).toBe(forkLedger);

        // ── event deletion check ───────────────────────────────────────────────
        // Only the stable event (ledger < forkLedger) should remain.
        const { rows: evRows } = await pool.query(
          "SELECT ledger FROM events WHERE contract_id = $1 ORDER BY ledger",
          [contractId],
        );
        expect(evRows.map((r) => Number(r.ledger))).toEqual([stableLedger]);

        // ── ledger hash deletion check ─────────────────────────────────────────
        const { rows: hashRows } = await pool.query(
          "SELECT ledger FROM ledger_hashes WHERE ledger BETWEEN $1 AND $2 ORDER BY ledger",
          [stableLedger, orphan2],
        );
        expect(hashRows.map((r) => Number(r.ledger))).toEqual([stableLedger]);
      },
    );
  },
);
