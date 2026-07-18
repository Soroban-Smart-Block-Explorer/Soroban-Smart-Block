import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  ALERT_CONDITIONS,
  fireAlert,
  resolveAlert,
  getActiveAlerts,
  recordPoll,
  checkLedgerGap,
  checkThroughput,
  checkDlqSize,
} from "../src/alertManager.js";

// Reset active alert state between tests by resolving all conditions
function resetAlerts() {
  for (const condition of Object.values(ALERT_CONDITIONS)) {
    resolveAlert(condition);
  }
}

describe("ALERT_CONDITIONS", () => {
  it("exports exactly 8 conditions", () => {
    assert.equal(Object.keys(ALERT_CONDITIONS).length, 8);
  });

  it("includes all required condition names", () => {
    const expected = [
      "INDEXER_DOWN",
      "LEDGER_GAP",
      "DB_FAILURE",
      "RESOURCE_CONSTRAINT",
      "ALL_RPC_DOWN",
      "LOW_THROUGHPUT",
      "DLQ_THRESHOLD",
      "REORG_DETECTED",
    ];
    for (const name of expected) {
      assert.ok(name in ALERT_CONDITIONS, `missing condition: ${name}`);
    }
  });
});

describe("fireAlert and resolveAlert", () => {
  beforeEach(() => resetAlerts());

  it("adds condition to active alerts on fire", async () => {
    await fireAlert(ALERT_CONDITIONS.LEDGER_GAP, "test gap");
    const active = getActiveAlerts();
    assert.ok(active.some((a) => a.condition === ALERT_CONDITIONS.LEDGER_GAP));
  });

  it("deduplicates repeated fires for the same condition", async () => {
    await fireAlert(ALERT_CONDITIONS.LEDGER_GAP, "first");
    await fireAlert(ALERT_CONDITIONS.LEDGER_GAP, "second");
    const active = getActiveAlerts().filter((a) => a.condition === ALERT_CONDITIONS.LEDGER_GAP);
    assert.equal(active.length, 1);
  });

  it("removes condition from active alerts on resolve", async () => {
    await fireAlert(ALERT_CONDITIONS.DB_FAILURE, "db down");
    resolveAlert(ALERT_CONDITIONS.DB_FAILURE);
    const active = getActiveAlerts();
    assert.ok(!active.some((a) => a.condition === ALERT_CONDITIONS.DB_FAILURE));
  });

  it("resolveAlert is a no-op for non-active conditions", () => {
    assert.doesNotThrow(() => resolveAlert(ALERT_CONDITIONS.ALL_RPC_DOWN));
  });

  it("active alert has an ISO firedAt timestamp and duration", async () => {
    await fireAlert(ALERT_CONDITIONS.REORG_DETECTED, "reorg at 999");
    const alert = getActiveAlerts().find((a) => a.condition === ALERT_CONDITIONS.REORG_DETECTED);
    assert.equal(new Date(alert.firedAt).toISOString(), alert.firedAt);
    assert.ok(Number.isInteger(alert.durationMs));
    assert.ok(alert.durationMs >= 0);
  });
});

describe("getActiveAlerts", () => {
  beforeEach(() => resetAlerts());

  it("returns empty array when no alerts are active", () => {
    assert.deepEqual(getActiveAlerts(), []);
  });

  it("returns all currently active alerts", async () => {
    await fireAlert(ALERT_CONDITIONS.INDEXER_DOWN, "stalled");
    await fireAlert(ALERT_CONDITIONS.LOW_THROUGHPUT, "slow");
    const active = getActiveAlerts();
    assert.equal(active.length, 2);
  });
});

describe("recordPoll", () => {
  beforeEach(() => resetAlerts());

  it("resolves INDEXER_DOWN when poll is recorded", async () => {
    await fireAlert(ALERT_CONDITIONS.INDEXER_DOWN, "stalled");
    recordPoll();
    const active = getActiveAlerts();
    assert.ok(!active.some((a) => a.condition === ALERT_CONDITIONS.INDEXER_DOWN));
  });
});

describe("checkLedgerGap", () => {
  beforeEach(() => resetAlerts());

  it("fires LEDGER_GAP when gap exceeds threshold", async () => {
    const threshold = Number(process.env.ALERT_GAP_THRESHOLD ?? 3);
    await checkLedgerGap(threshold + 1, 1000);
    const active = getActiveAlerts();
    assert.ok(active.some((a) => a.condition === ALERT_CONDITIONS.LEDGER_GAP));
  });

  it("resolves LEDGER_GAP when gap is within threshold", async () => {
    await fireAlert(ALERT_CONDITIONS.LEDGER_GAP, "previous gap");
    const threshold = Number(process.env.ALERT_GAP_THRESHOLD ?? 3);
    await checkLedgerGap(threshold - 1, 1000);
    const active = getActiveAlerts();
    assert.ok(!active.some((a) => a.condition === ALERT_CONDITIONS.LEDGER_GAP));
  });

  it("does not fire for gap equal to threshold", async () => {
    const threshold = Number(process.env.ALERT_GAP_THRESHOLD ?? 3);
    await checkLedgerGap(threshold, 1000);
    const active = getActiveAlerts();
    assert.ok(!active.some((a) => a.condition === ALERT_CONDITIONS.LEDGER_GAP));
  });
});

describe("checkThroughput", () => {
  beforeEach(() => resetAlerts());

  it("fires LOW_THROUGHPUT when rate is below minimum", async () => {
    const min = Number(process.env.ALERT_MIN_THROUGHPUT ?? 1);
    await checkThroughput(min - 0.5);
    const active = getActiveAlerts();
    assert.ok(active.some((a) => a.condition === ALERT_CONDITIONS.LOW_THROUGHPUT));
  });

  it("resolves LOW_THROUGHPUT when rate meets minimum", async () => {
    await fireAlert(ALERT_CONDITIONS.LOW_THROUGHPUT, "slow");
    const min = Number(process.env.ALERT_MIN_THROUGHPUT ?? 1);
    await checkThroughput(min + 1);
    const active = getActiveAlerts();
    assert.ok(!active.some((a) => a.condition === ALERT_CONDITIONS.LOW_THROUGHPUT));
  });
});

describe("checkDlqSize", () => {
  beforeEach(() => resetAlerts());

  it("fires DLQ_THRESHOLD when size exceeds maximum", async () => {
    const max = Number(process.env.ALERT_DLQ_MAX_SIZE ?? 100);
    await checkDlqSize(max + 1);
    const active = getActiveAlerts();
    assert.ok(active.some((a) => a.condition === ALERT_CONDITIONS.DLQ_THRESHOLD));
  });

  it("resolves DLQ_THRESHOLD when size is within maximum", async () => {
    await fireAlert(ALERT_CONDITIONS.DLQ_THRESHOLD, "full");
    const max = Number(process.env.ALERT_DLQ_MAX_SIZE ?? 100);
    await checkDlqSize(max - 1);
    const active = getActiveAlerts();
    assert.ok(!active.some((a) => a.condition === ALERT_CONDITIONS.DLQ_THRESHOLD));
  });
});
