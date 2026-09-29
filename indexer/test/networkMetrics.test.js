import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computeLedgerMetrics, recommendFee, staleness, percentile } from "../src/networkMetrics.js";

const fx = JSON.parse(readFileSync(new URL("./fixtures/networkMetrics.json", import.meta.url)));
const metrics = fx.ledgers.map((l, i) =>
  computeLedgerMetrics({ ...l, limits: fx.limits, prev_closed_at: fx.ledgers[i - 1]?.closed_at }),
);

test("percentile uses nearest-rank", () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([1, 2, 3, 4], 50), 2);
  assert.equal(percentile([1, 2, 3, 4], 99), 4);
});

test("computes tx count, close time, TPS and fee percentiles", () => {
  assert.equal(metrics[0].close_time, null);
  assert.equal(metrics[1].tx_count, 2);
  assert.equal(metrics[1].close_time, 5);
  assert.equal(metrics[1].tps, 0.4);
  assert.deepEqual(metrics[2].fees, { p10: 100, p50: 300, p90: 1000, p99: 1000 });
});

test("utilization is read from per-ledger limits and drives the surge flag", () => {
  assert.equal(metrics[1].utilization.tx_count, 0.5);
  assert.equal(metrics[1].surge, false);
  assert.equal(metrics[2].utilization.tx_count, 1);
  assert.equal(metrics[2].surge, true);
  const noLimits = computeLedgerMetrics({ ...fx.ledgers[1] });
  assert.equal(noLimits.utilization.instructions, null);
});

test("recommended fee and staleness", () => {
  assert.deepEqual(recommendFee(metrics), { fee: 1000, surge: true });
  assert.equal(recommendFee([]), null);
  assert.equal(staleness(metrics, Date.parse("2026-01-01T00:01:10Z")), 60);
});
