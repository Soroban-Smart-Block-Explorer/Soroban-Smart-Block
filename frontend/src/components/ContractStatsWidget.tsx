import { useQuery } from "@tanstack/react-query";
import { api } from "../api";

/** 30-day daily event-count sparkline — plain SVG, no chart library. */
function Sparkline({ data }: { data: { date: string; count: number }[] }) {
  const w = 300;
  const h = 40;
  const maxCount = Math.max(...data.map((d) => d.count), 1);
  const pts = data
    .map((d, i) => {
      const x = (i / (data.length - 1 || 1)) * w;
      const y = h - (d.count / maxCount) * h;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <svg
      width="100%"
      viewBox={`0 0 ${w} ${h}`}
      style={{ display: "block", overflow: "visible" }}
      aria-label="Events per day over the last 30 days"
    >
      <polyline points={pts} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      {data.map((d, i) => {
        const x = (i / (data.length - 1 || 1)) * w;
        const y = h - (d.count / maxCount) * h;
        return (
          <circle key={d.date} cx={x} cy={y} r={2} fill="var(--accent)">
            <title>
              {d.date}: {d.count} event{d.count === 1 ? "" : "s"}
            </title>
          </circle>
        );
      })}
    </svg>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 20, fontWeight: 700 }}>{value}</div>
      <div style={{ fontSize: 12, color: "var(--muted)" }}>{label}</div>
    </div>
  );
}

export default function ContractStatsWidget({ contractId }: { contractId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["contract-stats", contractId],
    queryFn: () => api.contractStats(contractId),
    enabled: !!contractId,
  });

  if (isLoading) return <p style={{ color: "var(--muted)" }}>Loading stats…</p>;
  if (!data) return null;

  return (
    <div className="card" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", gap: 32, flexWrap: "wrap" }}>
        <Stat label="Total Events" value={data.total_events.toLocaleString()} />
        <Stat label="Unique Callers" value={data.unique_callers.toLocaleString()} />
        <Stat label="Last Activity" value={data.last_seen_ledger != null ? `Ledger ${data.last_seen_ledger.toLocaleString()}` : "—"} />
      </div>
      <div>
        <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 6 }}>Events / day (last 30 days)</div>
        <Sparkline data={data.events_per_day} />
      </div>
    </div>
  );
}
