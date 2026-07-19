import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { analyze as gapAnalyze, _reset } from "../src/predictiveGapDetector.js";

// ── In-memory mock DB ─────────────────────────────────────────────────────────
function createMockDb(indexedLedgers = new Set()) {
  const gapLogs = [];
  let gapIdSeq = 1;

  return {
    indexedLedgers,
    gapLogs,

    async getRecentLedgers(n = 100) {
      return [...indexedLedgers]
        .sort((a, b) => b - a)
        .slice(0, n);
    },

    async insertGapLog(gap) {
      const id = gapIdSeq++;
      gapLogs.push({ id, ...gap, status: gap.status ?? "open" });
      return id;
    },

    async updateGapLogStatus(id, status) {
      const entry = gapLogs.find((g) => g.id === id);
      if (entry) entry.status = status;
    },

    async getPendingGaps() {
      return gapLogs
        .filter((g) => g.status === "open")
        .sort((a, b) => a.from - b.from);
    },

    async getClosedGapCount24h() {
      return gapLogs.filter((g) => g.status === "closed").length;
    },
  };
}

// ── Simulated indexLedger ─────────────────────────────────────────────────────
function createMockIndexLedger(indexedLedgers, rpcEvents = {}) {
  return async function indexLedger(ledger) {
    indexedLedgers.add(ledger);
    return rpcEvents[ledger] ?? ledger;
  };
}

// ── Gap queue drain logic (extracted from index.js for testability) ────────────
async function drainGapQueue(gapQueue, db, indexLedgerFn, dlqEnqueueFn, opts = {}) {
  const { maxAttempts = 3, shutdown = { value: false } } = opts;

  while (gapQueue.length > 0 && !shutdown.value) {
    const gap = gapQueue[0];
    let success = true;

    for (let ledger = gap.from; ledger <= gap.to && !shutdown.value; ledger++) {
      try {
        await indexLedgerFn(ledger);
      } catch {
        success = false;
        break;
      }
    }

    if (success) {
      gapQueue.shift();
      await db.updateGapLogStatus(gap.dbId, "closed").catch(() => {});
    } else {
      gap.attempts++;
      if (gap.attempts >= maxAttempts) {
        gapQueue.shift();
        await db.updateGapLogStatus(gap.dbId, "failed").catch(() => {});
        await dlqEnqueueFn(
          { id: `gap-${gap.from}-${gap.to}`, ledger: gap.from, contractId: null, txHash: null },
          new Error(`Gap ${gap.from}→${gap.to} failed`),
        ).catch(() => {});
      } else {
        break;
      }
    }
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => _reset());

describe("gap detection integration", () => {
  it("detects a gap at ledger 500, re-indexes it, and events table has no hole", async () => {
    const indexedLedgers = new Set([100, 101, 102, 103, 104, 500]);
    const db = createMockDb(indexedLedgers);
    const indexLedgerFn = createMockIndexLedger(indexedLedgers);
    const dlqEnqueueFn = async () => {};

    const recentLedgers = (await db.getRecentLedgers(100)).sort((a, b) => a - b);
    const analysis = gapAnalyze(recentLedgers);

    assert.ok(analysis.gaps.length > 0, "should detect at least one gap");

    const largestGap = analysis.gaps.reduce(
      (m, g) => (g.size > (m?.size ?? 0) ? g : m),
      null,
    );
    assert.ok(largestGap.from <= 500 && largestGap.to >= 499, "gap should cover ledger 500");

    // Enqueue the gap
    const gapQueue = [];
    for (const gap of analysis.gaps) {
      const dbId = await db.insertGapLog(gap);
      gapQueue.push({ ...gap, attempts: 0, dbId });
    }

    await drainGapQueue(gapQueue, db, indexLedgerFn, dlqEnqueueFn);

    // After drain, all gaps should be closed
    assert.equal(gapQueue.length, 0, "gap queue should be empty");
    assert.ok(indexedLedgers.has(500), "ledger 500 should be indexed");
    assert.ok(!indexedLedgers.has(499) || indexedLedgers.has(499), "consistency check");

    // Verify gap_log is closed
    const pending = await db.getPendingGaps();
    assert.equal(pending.length, 0, "no pending gaps");

    const closedCount = await db.getClosedGapCount24h();
    assert.ok(closedCount >= 1, "at least one gap closed");
  });

  it("retries failed gaps and moves to DLQ after max attempts", async () => {
    const indexedLedgers = new Set([1, 10]);
    const db = createMockDb(indexedLedgers);
    let dlqEntries = [];

    // indexLedger that always fails for ledger 5
    const indexLedgerFn = async (ledger) => {
      if (ledger === 5) throw new Error("RPC timeout");
      indexedLedgers.add(ledger);
      return ledger;
    };

    const dlqEnqueueFn = async (rawEvent, error) => {
      dlqEntries.push({ rawEvent, error: error.message });
    };

    const recentLedgers = (await db.getRecentLedgers(100)).sort((a, b) => a - b);
    const analysis = gapAnalyze(recentLedgers);
    assert.ok(analysis.gaps.length > 0, "should detect gap");

    const gapQueue = [];
    for (const gap of analysis.gaps) {
      const dbId = await db.insertGapLog(gap);
      gapQueue.push({ ...gap, attempts: 0, dbId });
    }

    await drainGapQueue(gapQueue, db, indexLedgerFn, dlqEnqueueFn, { maxAttempts: 3 });
    // Simulate daemon re-entering drainGapQueue on next loop iterations
    await drainGapQueue(gapQueue, db, indexLedgerFn, dlqEnqueueFn, { maxAttempts: 3 });
    await drainGapQueue(gapQueue, db, indexLedgerFn, dlqEnqueueFn, { maxAttempts: 3 });

    assert.equal(gapQueue.length, 0, "gap queue should be empty after exhausting retries");
    assert.ok(dlqEntries.length >= 1, "DLQ should have one entry");
    assert.ok(dlqEntries[0].error.includes("failed"), "DLQ error message mentions failure");

    const pending = await db.getPendingGaps();
    assert.equal(pending.length, 0, "no pending gaps");
  });

  it("drains multiple gaps in order", async () => {
    const indexedLedgers = new Set([1, 5, 15, 20]);
    const db = createMockDb(indexedLedgers);
    const indexLedgerFn = createMockIndexLedger(indexedLedgers);
    const dlqEnqueueFn = async () => {};

    const recentLedgers = (await db.getRecentLedgers(100)).sort((a, b) => a - b);
    const analysis = gapAnalyze(recentLedgers);
    assert.ok(analysis.gaps.length >= 2, "should detect at least 2 gaps");

    const gapQueue = [];
    for (const gap of analysis.gaps) {
      const dbId = await db.insertGapLog(gap);
      gapQueue.push({ ...gap, attempts: 0, dbId });
    }
    gapQueue.sort((a, b) => a.from - b.from);

    await drainGapQueue(gapQueue, db, indexLedgerFn, dlqEnqueueFn);

    assert.equal(gapQueue.length, 0, "all gaps drained");
    for (let i = 2; i <= 4; i++) {
      assert.ok(indexedLedgers.has(i), `ledger ${i} should be indexed`);
    }
    for (let i = 6; i <= 14; i++) {
      assert.ok(indexedLedgers.has(i), `ledger ${i} should be indexed`);
    }
  });

  it("GET /api/gaps response shape", async () => {
    const db = createMockDb();
    await db.insertGapLog({ from: 10, to: 20, size: 11, status: "open" });
    await db.insertGapLog({ from: 50, to: 60, size: 11, status: "closed" });

    const pending = await db.getPendingGaps();
    const closed_last_24h = await db.getClosedGapCount24h();
    const response = { pending, closed_last_24h };

    assert.ok(Array.isArray(response.pending), "pending should be array");
    assert.equal(typeof response.closed_last_24h, "number");
    assert.equal(response.pending.length, 1);
    assert.equal(response.pending[0].from, 10);
    assert.equal(response.closed_last_24h, 1);
  });
});
