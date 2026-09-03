import { jest } from "@jest/globals";
import { readFileSync } from "node:fs";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
process.env.DATABASE_URL = TEST_DATABASE_URL || "postgres://unused:unused@localhost:5432/unused";

const { checkForReorg } = await import("../src/reorgWorker.js");
const { db, pool } = await import("../src/db.js");

describe("reorganization detection", () => {
  it("returns the fork after one rollback even when alert delivery fails", async () => {
    const rpc = {
      getLedger: jest.fn(async (ledger) => ({
        hash: ledger === 12245 ? "stable-hash" : "network-hash",
      })),
    };
    const rollbackFork = jest.fn().mockResolvedValue();
    const alertReorg = jest.fn().mockRejectedValue(new Error("notification unavailable"));
    const consoleError = jest.spyOn(console, "error").mockImplementation();
    const getStoredHashes = jest.fn().mockResolvedValue([
      { ledger: "12345", hash: "stored-hash" },
      { ledger: "12245", hash: "stable-hash" },
      // A 50-ledger reorg behind the previous 100-ledger check boundary:
      // exactly 150 ledgers behind the newest stored row.
      { ledger: "12195", hash: "fork-stored-hash" },
    ]);

    try {
      const forkLedger = await checkForReorg(rpc, {
        getStoredHashes,
        rollbackFork,
        alertReorg,
      });

      expect(forkLedger).toBe(12195);
      expect(getStoredHashes).toHaveBeenCalledWith(200);
      expect(rpc.getLedger).toHaveBeenCalledWith(12345);
      expect(rpc.getLedger).toHaveBeenCalledWith(12195);
      expect(rollbackFork).toHaveBeenCalledTimes(1);
      expect(rollbackFork).toHaveBeenCalledWith(12195);
      expect(alertReorg).toHaveBeenCalledTimes(1);
      expect(alertReorg).toHaveBeenCalledWith(12195);
      expect(consoleError).toHaveBeenCalledWith(
        "[reorg] Alert failed at ledger 12195: notification unavailable",
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("combines custom check interval and supported depth", async () => {
    const getStoredHashes = jest.fn().mockResolvedValue([]);

    const forkLedger = await checkForReorg(
      { getLedger: jest.fn() },
      { getStoredHashes, checkInterval: 7, maxDepth: 3 },
    );

    expect(forkLedger).toBeNull();
    expect(getStoredHashes).toHaveBeenCalledWith(10);
  });

  it("keeps production lookback bounded and resets only after a successful check", () => {
    const indexSource = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
    const checkCall = indexSource.indexOf("const forkLedger = await checkForReorg(rpc);");
    const resetAfterCheck = indexSource.indexOf("ledgersSinceReorgCheck = 0", checkCall);

    expect(checkCall).toBeGreaterThan(-1);
    expect(indexSource).not.toContain("checkInterval: ledgersSinceReorgCheck");
    expect(resetAfterCheck).toBeGreaterThan(checkCall);
  });

  it("detects and rolls back overlapping reorgs at different fork points", async () => {
    const rpc = {
      getLedger: jest.fn(async (ledger) => {
        // Simulate network state where ledgers 98-103 have diverged
        if (ledger >= 98 && ledger <= 103) return { hash: "network-fork-hash" };
        return { hash: "stable-hash" };
      }),
    };
    const rollbackFork = jest.fn().mockResolvedValue();
    const alertReorg = jest.fn().mockResolvedValue();
    const getStoredHashes = jest.fn().mockResolvedValue([
      { ledger: "110", hash: "stable-hash" },
      { ledger: "105", hash: "stable-hash" },
      { ledger: "100", hash: "stored-fork-hash-1" },
      { ledger: "99", hash: "stored-fork-hash-2" },
      { ledger: "98", hash: "stored-fork-hash-3" },
    ]);

    const forkLedger = await checkForReorg(rpc, {
      getStoredHashes,
      rollbackFork,
      alertReorg,
    });

    // Should detect the earliest fork point across all mismatched ledgers
    expect(forkLedger).toBe(98);
    expect(rollbackFork).toHaveBeenCalledTimes(1);
    expect(rollbackFork).toHaveBeenCalledWith(98);
    expect(alertReorg).toHaveBeenCalledTimes(1);
    expect(alertReorg).toHaveBeenCalledWith(98);
  });

  it("handles multiple reorg checks in rapid succession with consistent state", async () => {
    const getStoredHashesCall1 = [
      { ledger: "110", hash: "stable-hash" },
      { ledger: "105", hash: "stored-fork-hash-1" },
      { ledger: "100", hash: "stored-fork-hash-2" },
    ];
    const getStoredHashesCall2 = [
      { ledger: "110", hash: "stable-hash" },
      { ledger: "105", hash: "stored-fork-hash-1" },
      // After first rollback from ledger 100, ledger 100 is removed from stored hashes
    ];

    const rollbackFork = jest.fn().mockResolvedValue();
    const alertReorg = jest.fn().mockResolvedValue();
    const getStoredHashes = jest
      .fn()
      .mockResolvedValueOnce(getStoredHashesCall1)
      .mockResolvedValueOnce(getStoredHashesCall2);

    const rpc = {
      getLedger: jest.fn(async (ledger) => {
        if (ledger === 105) return { hash: "network-fork-hash" };
        if (ledger === 100) return { hash: "network-fork-hash" };
        return { hash: "stable-hash" };
      }),
    };

    // First reorg check detects fork at ledger 100
    const fork1 = await checkForReorg(rpc, {
      getStoredHashes,
      rollbackFork,
      alertReorg,
    });
    expect(fork1).toBe(100);
    expect(rollbackFork).toHaveBeenCalledWith(100);

    // Second reorg check after first rollback
    const fork2 = await checkForReorg(rpc, {
      getStoredHashes,
      rollbackFork,
      alertReorg,
    });

    // Second check detects fork at ledger 105 (since 100 was already rolled back)
    expect(fork2).toBe(105);
    expect(rollbackFork).toHaveBeenCalledWith(105);
    expect(rollbackFork).toHaveBeenCalledTimes(2);
  });
});

const describeWithDatabase = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDatabase("reorganization rollback (PostgreSQL integration)", () => {
  const forkLedger = 8_000_000_000 + (Date.now() % 100_000_000);
  const contractId = `REORG_TEST_${forkLedger}`;
  let previousCursor = null;

  beforeAll(async () => {
    await db.init();
    const { rows: cursorRows } = await pool.query(
      "SELECT value FROM daemon_state WHERE key = 'cursor'",
    );
    previousCursor = cursorRows[0]?.value ?? null;
    await pool.query(
      `INSERT INTO events (contract_id, function, ledger, description)
       VALUES ($1, 'stable', $2, 'before fork'),
              ($1, 'orphaned', $3, 'at fork'),
              ($1, 'orphaned', $4, 'above fork')`,
      [contractId, forkLedger - 1, forkLedger, forkLedger + 1],
    );
    await pool.query(
      `INSERT INTO ledger_hashes (ledger, hash)
       VALUES ($1, 'stable-before'), ($2, 'stored-fork'), ($3, 'stable-after')`,
      [forkLedger - 1, forkLedger, forkLedger + 1],
    );
  });

  afterAll(async () => {
    await pool.query("DELETE FROM events WHERE contract_id = $1", [contractId]);
    await pool.query("DELETE FROM ledger_hashes WHERE ledger BETWEEN $1 AND $2", [
      forkLedger - 1,
      forkLedger + 1,
    ]);
    if (previousCursor === null) {
      await pool.query("DELETE FROM daemon_state WHERE key = 'cursor'");
    } else {
      await pool.query(
        `INSERT INTO daemon_state (key, value) VALUES ('cursor', $1)
         ON CONFLICT (key) DO UPDATE SET value = $1`,
        [previousCursor],
      );
    }
    await pool.end();
  });

  it("deletes orphaned rows and persists the detected fork cursor", async () => {
    const rpc = {
      getLedger: jest.fn(async (ledger) => {
        if (ledger === forkLedger) return { hash: "network-fork" };
        if (ledger === forkLedger + 1) return { hash: "network-after" };
        return { hash: "stable-before" };
      }),
    };
    const alertReorg = jest.fn().mockResolvedValue();

    const detectedFork = await checkForReorg(rpc, { alertReorg });

    expect(detectedFork).toBe(forkLedger);
    expect(alertReorg).toHaveBeenCalledTimes(1);
    expect(alertReorg).toHaveBeenCalledWith(forkLedger);

    const { rows: events } = await pool.query(
      "SELECT ledger FROM events WHERE contract_id = $1 ORDER BY ledger",
      [contractId],
    );
    expect(events.map((row) => Number(row.ledger))).toEqual([forkLedger - 1]);

    const { rows: hashes } = await pool.query(
      "SELECT ledger FROM ledger_hashes WHERE ledger BETWEEN $1 AND $2 ORDER BY ledger",
      [forkLedger - 1, forkLedger + 1],
    );
    expect(hashes.map((row) => Number(row.ledger))).toEqual([forkLedger - 1]);

    const { rows: cursorRows } = await pool.query(
      "SELECT value FROM daemon_state WHERE key = 'cursor'",
    );
    expect(Number(cursorRows[0].value)).toBe(forkLedger);
  });
});
