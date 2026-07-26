/**
 * InvocationFrequencyChart — SVG bar chart of daily contract invocations
 * over the last 30 days, backed by GET /api/contracts/:id/stats.
 */
import { useQuery } from "@tanstack/react-query";
import { api, type DailyEventCount } from "../api";

const CHART_W = 600;
const CHART_H = 120;
const BAR_GAP = 2;

function formatDateShort(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

function Bars({ data }: { data: DailyEventCount[] }) {
  const max = Math.max(...data.map((d) => d.count), 1);
  const barW = CHART_W / data.length - BAR_GAP;

  return (
    <svg
      width="100%"
      viewBox={`0 0 ${CHART_W} ${CHART_H}`}
      style={{ display: "block", overflow: "visible" }}
      role="img"
      aria-label="Invocation frequency for the last 30 days"
    >
      {data.map((d, i) => {
        const barH = Math.max(d.count > 0 ? 2 : 0, (d.count / max) * (CHART_H - 4));
        const x = i * (barW + BAR_GAP);
        const y = CHART_H - barH;
        return (
          <rect
            key={d.date}
            x={x}
            y={y}
            width={Math.max(barW, 1)}
            height={barH}
            fill="var(--accent, #58a6ff)"
            rx={1}
            role="img"
            aria-label={`${formatDateShort(d.date)}: ${d.count} event${d.count === 1 ? "" : "s"}`}
          >
            <title>
              {formatDateShort(d.date)}: {d.count} event{d.count === 1 ? "" : "s"}
            </title>
          </rect>
        );
      })}
    </svg>
  );
}

export default function InvocationFrequencyChart({ contractId }: { contractId: string }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["contract-stats", contractId],
    queryFn: () => api.contractStats(contractId),
    enabled: !!contractId,
  });

  if (isLoading) return <p style={{ color: "var(--muted)", fontSize: 13 }}>Loading activity…</p>;
  if (isError || !data) return null;

  const days = data.events_per_day;
  const hasActivity = days.some((d) => d.count > 0);

  return (
    <div className="card" style={{ padding: "14px 16px" }}>
      <h3
        style={{
          fontSize: 13,
          marginBottom: 12,
          color: "var(--muted)",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}
      >
        Invocation Frequency (Last 30 Days)
      </h3>
      {hasActivity ? (
        <>
          <Bars data={days} />
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: 11,
              color: "var(--muted)",
              marginTop: 6,
            }}
          >
            <span>{formatDateShort(days[0].date)}</span>
            <span>{formatDateShort(days[days.length - 1].date)}</span>
          </div>
        </>
      ) : (
        <p style={{ color: "var(--muted)", fontSize: 13, margin: 0 }}>No activity in the last 30 days</p>
      )}
    </div>
  );
}
