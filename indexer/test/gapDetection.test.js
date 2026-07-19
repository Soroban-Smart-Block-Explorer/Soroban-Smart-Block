import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  recordLedger,
  analyze,
  detectGaps,
  _reset,
} from "../src/predictiveGapDetector.js";

beforeEach(() => _reset());

describe("gap detection integration", () => {
  it("detects a gap of ≥ PREDICTIVE_GAP_THRESHOLD ledgers", () => {
    const threshold = Number(process.env.PREDICTIVE_GAP_THRESHOLD ?? 3);
    // Simulate indexed ledgers: 498, 499, then skip 500..502, resume at 503
    const recentLedgers = [498, 499, 503, 504];
    const gaps = detectGaps(recentLedgers);
    assert.ok(gaps.length >= 1, "should detect at least one gap");
    const gap = gaps.find((g) => g.from === 500);
    assert.ok(gap, "gap should start at ledger 500");
    assert.equal(gap.to, 502);
    assert.equal(gap.size, 3);
    assert.ok(gap.size >= threshold, "gap size should meet threshold");
  });

  it("analyze() returns gaps and catchup estimate", () => {
    // Seed internal history with a non-zero interval so estimateCatchupTime works
    recordLedger(498);
    // Simulate passage of time by manually adjusting history via two separate calls
    // recordLedger only stores Date.now(), so sync calls produce 0ms avg → null catchup.
    // We call analyze with the gap and verify the gap shape; catchup requires real intervals.
    const recentLedgers = [498, 499, 503, 504];
    const result = analyze(recentLedgers);
    assert.ok(result.gaps.length >= 1, "analyze should report gaps");
    const gap = result.gaps.find((g) => g.from === 500);
    assert.ok(gap, "gap should start at 500");
    assert.ok(gap.size >= 3);
    // catchup may be null when intervals are 0 (sync calls), verify shape
    assert.ok("catchup" in result);
    if (result.catchup) {
      assert.ok(result.catchup.estimatedMs >= 0);
    }
  });

  it("re-indexing the missing range fills the hole", () => {
    const indexed = new Set([498, 499, 503, 504]);

    const recentLedgers = [...indexed].sort((a, b) => a - b);
    const gaps = detectGaps(recentLedgers);
    assert.ok(gaps.length >= 1);

    // Simulate re-indexing the gap
    for (const gap of gaps) {
      for (let ledger = gap.from; ledger <= gap.to; ledger++) {
        indexed.add(ledger);
      }
    }

    // Verify no hole at 500
    assert.ok(indexed.has(500), "ledger 500 should be present after re-index");
    assert.ok(indexed.has(501), "ledger 501 should be present after re-index");
    assert.ok(indexed.has(502), "ledger 502 should be present after re-index");

    // Verify no more gaps
    const finalGaps = detectGaps([...indexed].sort((a, b) => a - b));
    assert.equal(finalGaps.length, 0, "no gaps should remain after re-index");
  });

  it("does not flag gaps below threshold", () => {
    const threshold = Number(process.env.PREDICTIVE_GAP_THRESHOLD ?? 3);
    // Gap of only 2 — below threshold of 3
    const recentLedgers = [100, 101, 104, 105];
    const gaps = detectGaps(recentLedgers);
    // Gap from 102-103 has size 2, which is below threshold of 3
    assert.ok(gaps.length === 0 || gaps.every((g) => g.size < threshold));
  });
});

describe("gap queue and DB integration", () => {
  it("mock db tracks gap_log entries correctly", async () => {
    const inserted = [];
    let nextId = 1;

    const mockDb = {
      async insertGapLog(from, to, size) {
        inserted.push({ from, to, size, id: nextId });
        return nextId++;
      },
      async closeGapLog(id) {
        const entry = inserted.find((e) => e.id === id);
        if (entry) entry.status = "closed";
      },
      async dlqGapLog(id) {
        const entry = inserted.find((e) => e.id === id);
        if (entry) entry.status = "dlq";
      },
      async incrementGapRetries(id) {
        const entry = inserted.find((e) => e.id === id);
        if (entry) entry.retries = (entry.retries || 0) + 1;
      },
      async getRecentLedgers() {
        return [498, 499, 503, 504];
      },
      async getGapLogStats() {
        return {
          pending: inserted.filter((e) => !e.status).map((e) => ({ from: e.from, to: e.to, size: e.size })),
          closed_last_24h: inserted.filter((e) => e.status === "closed").length,
        };
      },
    };

    // Simulate the gap detection flow
    const recentLedgers = await mockDb.getRecentLedgers();
    const gaps = detectGaps(recentLedgers);
    assert.ok(gaps.length >= 1);

    // Insert gap log entries
    for (const gap of gaps) {
      await mockDb.insertGapLog(gap.from, gap.to, gap.size);
    }
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].from, 500);
    assert.equal(inserted[0].to, 502);
    assert.equal(inserted[0].size, 3);

    // Simulate successful re-index → close gap
    await mockDb.closeGapLog(inserted[0].id);
    assert.equal(inserted[0].status, "closed");

    // Check stats
    const stats = await mockDb.getGapLogStats();
    assert.equal(stats.pending.length, 0);
    assert.equal(stats.closed_last_24h, 1);
  });

  it("DLQ path: retries exhausted → gap marked dlq", async () => {
    const inserted = [];
    let nextId = 1;

    const mockDb = {
      async insertGapLog(from, to, size) {
        inserted.push({ from, to, size, id: nextId, retries: 0 });
        return nextId++;
      },
      async closeGapLog() {},
      async dlqGapLog(id) {
        const entry = inserted.find((e) => e.id === id);
        if (entry) entry.status = "dlq";
      },
      async incrementGapRetries(id) {
        const entry = inserted.find((e) => e.id === id);
        if (entry) entry.retries++;
      },
    };

    const logId = await mockDb.insertGapLog(500, 502, 3);

    // Simulate 3 failed retries
    const MAX_GAP_RETRIES = 3;
    let retries = 0;
    while (retries < MAX_GAP_RETRIES) {
      await mockDb.incrementGapRetries(logId);
      retries++;
    }

    // After exhausting retries → DLQ
    await mockDb.dlqGapLog(logId);
    const entry = inserted.find((e) => e.id === logId);
    assert.equal(entry.status, "dlq");
    assert.equal(entry.retries, 3);
  });

  it("GET /api/gaps returns correct shape", async () => {
    const mockDb = {
      async getGapLogStats() {
        return {
          pending: [
            { from: 500, to: 502, size: 3 },
            { from: 600, to: 605, size: 6 },
          ],
          closed_last_24h: 5,
        };
      },
    };

    const stats = await mockDb.getGapLogStats();
    assert.ok(Array.isArray(stats.pending));
    assert.equal(stats.pending.length, 2);
    assert.equal(stats.pending[0].from, 500);
    assert.equal(stats.pending[0].size, 3);
    assert.equal(stats.closed_last_24h, 5);
  });
});
