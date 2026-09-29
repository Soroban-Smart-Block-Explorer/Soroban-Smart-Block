import { describe, it, expect } from "vitest";
import { appendLedgerPoint, MAX_LIVE_POINTS } from "./NetworkDashboard";
import type { NetworkLedgerMetric } from "../api";

const metric = (ledger: number): NetworkLedgerMetric => ({
  ledger,
  closed_at: new Date(ledger * 5000).toISOString(),
  tx_count: 1,
  close_time: 5,
  tps: 0.2,
  fees: { p10: 100, p50: 100, p90: 100, p99: 100 },
  utilization: { tx_count: 0.1, instructions: 0.1, read_bytes: 0.1, write_bytes: 0.1 },
  surge: false,
});

describe("network dashboard live buffer", () => {
  it("stays bounded after an hour-plus of streamed ledgers", () => {
    let points: NetworkLedgerMetric[] = [];
    // 2 h of ledgers at 5 s cadence.
    for (let l = 1; l <= 1440; l++) points = appendLedgerPoint(points, metric(l));
    expect(points).toHaveLength(MAX_LIVE_POINTS);
    expect(points[0].ledger).toBe(1440 - MAX_LIVE_POINTS + 1);
    expect(points[points.length - 1].ledger).toBe(1440);
  });

  it("ignores duplicate or out-of-order ledgers", () => {
    const points = appendLedgerPoint([metric(5)], metric(5));
    expect(points).toHaveLength(1);
  });
});
