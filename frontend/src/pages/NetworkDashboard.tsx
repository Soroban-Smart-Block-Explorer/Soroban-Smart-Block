/**
 * Issue #921: real-time network dashboard — TPS, close time, fee percentiles,
 * surge pricing and resource utilization. Live mode streams one point per
 * ledger into a bounded buffer so long-lived tabs do not grow in memory.
 */
import { useEffect, useMemo, useState } from "react";
import { api, type NetworkLedgerMetric, type NetworkMetricsResponse } from "../api";
import NetworkMetricChart from "../components/dashboard/NetworkMetricChart";

type Range = NetworkMetricsResponse["range"];
// 1 h of ledgers at ~5 s cadence.
export const MAX_LIVE_POINTS = 720;
const STALE_AFTER_SECONDS = 60;

// Appends one streamed ledger, dropping duplicates and evicting the oldest point
// once the buffer is full, so memory stays bounded for long-lived tabs.
export function appendLedgerPoint(prev: NetworkLedgerMetric[], metric: NetworkLedgerMetric): NetworkLedgerMetric[] {
  if (prev.length && prev[prev.length - 1].ledger >= metric.ledger) return prev;
  const next = prev.length >= MAX_LIVE_POINTS ? prev.slice(prev.length - MAX_LIVE_POINTS + 1) : prev.slice();
  next.push(metric);
  return next;
}

export default function NetworkDashboard() {
  const [range, setRange] = useState<Range>("1h");
  const [points, setPoints] = useState<NetworkLedgerMetric[]>([]);
  const [recommended, setRecommended] = useState<NetworkMetricsResponse["recommended"]>(null);
  const [lastClose, setLastClose] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api
      .networkMetrics(range)
      .then((r) => {
        if (cancelled) return;
        setPoints(r.metrics.slice(-MAX_LIVE_POINTS));
        setRecommended(r.recommended);
        const last = r.metrics[r.metrics.length - 1];
        setLastClose(last ? Date.parse(last.closed_at) : null);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    if (range !== "1h" || typeof EventSource === "undefined") return () => void (cancelled = true);
    const es = new EventSource(api.networkMetricsStreamUrl);
    es.onmessage = (ev) => {
      const msg = JSON.parse(ev.data) as {
        metric: NetworkLedgerMetric;
        recommended: NetworkMetricsResponse["recommended"];
      };
      setPoints((prev) => appendLedgerPoint(prev, msg.metric));
      setRecommended(msg.recommended);
      setLastClose(Date.parse(msg.metric.closed_at));
    };
    return () => {
      cancelled = true;
      es.close();
    };
  }, [range]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);

  const series = useMemo(
    () => ({
      tps: points.map((p) => p.tps),
      close: points.map((p) => p.close_time),
      txs: points.map((p) => p.tx_count),
      p50: points.map((p) => p.fees.p50),
      p90: points.map((p) => p.fees.p90),
      p99: points.map((p) => p.fees.p99),
      instr: points.map((p) => p.utilization.instructions),
      read: points.map((p) => p.utilization.read_bytes),
      write: points.map((p) => p.utilization.write_bytes),
      txUtil: points.map((p) => p.utilization.tx_count),
    }),
    [points],
  );
  const staleSeconds = lastClose == null ? null : Math.round((now - lastClose) / 1000);
  const surge = points[points.length - 1]?.surge ?? false;
  const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
  const stroops = (v: number) => `${Math.round(v)} stroops`;

  return (
    <div>
      <h1>Network</h1>
      <div role="group" aria-label="Time range" style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        {(["1h", "24h", "7d"] as Range[]).map((r) => (
          <button
            key={r}
            aria-pressed={range === r}
            onClick={() => setRange(r)}
            style={{ minHeight: 44, minWidth: 44 }}
          >
            {r}
          </button>
        ))}
      </div>
      {error && <p role="alert">Failed to load metrics: {error}</p>}
      {staleSeconds != null && staleSeconds > STALE_AFTER_SECONDS && (
        <p role="status" data-testid="staleness" style={{ color: "var(--warning, #b45309)" }}>
          Indexer is lagging — latest data is {staleSeconds}s old.
        </p>
      )}
      <section
        aria-label="Recommended fee"
        style={{ padding: 12, border: "1px solid var(--border)", borderRadius: 8, marginBottom: 16 }}
      >
        <strong>Recommended inclusion fee: </strong>
        {recommended?.fee != null ? stroops(recommended.fee) : "—"}
        {surge && <span style={{ marginLeft: 8, color: "#ef4444", fontWeight: 700 }}>Surge pricing active</span>}
      </section>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 }}>
        <NetworkMetricChart label="TPS" values={series.tps} />
        <NetworkMetricChart label="Ledger close time (s)" values={series.close} format={(v) => v.toFixed(1)} />
        <NetworkMetricChart label="Soroban txs / ledger" values={series.txs} format={(v) => String(v)} />
        <NetworkMetricChart label="Fee p50" values={series.p50} format={stroops} />
        <NetworkMetricChart label="Fee p90" values={series.p90} format={stroops} />
        <NetworkMetricChart label="Fee p99" values={series.p99} format={stroops} />
        <NetworkMetricChart label="Instructions utilization" values={series.instr} format={pct} />
        <NetworkMetricChart label="Read bytes utilization" values={series.read} format={pct} />
        <NetworkMetricChart label="Write bytes utilization" values={series.write} format={pct} />
        <NetworkMetricChart label="Tx count utilization" values={series.txUtil} format={pct} />
      </div>
    </div>
  );
}
