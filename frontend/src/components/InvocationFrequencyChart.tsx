/**
 * InvocationFrequencyChart — SVG bar chart of contract event volume over a
 * selectable time range (30/90/365-day presets), backed by
 * GET /api/contracts/:id/stats?range=. Long ranges (> 90 days) are bucketed
 * into weekly windows so the historical trend stays readable at chart width.
 */
import { useQuery } from "@tanstack/react-query";
import { api, type DailyEventCount } from "../api";

/** Selectable trailing-day presets for the event-volume trend (#799). */
export type StatsRange = 30 | 90 | 365;

export const STATS_RANGE_OPTIONS: { label: string; days: StatsRange }[] = [
  { label: "30D", days: 30 },
  { label: "90D", days: 90 },
  { label: "365D", days: 365 },
];

const CHART_W = 600;
const CHART_H = 120;
const BAR_GAP = 2;

function formatDateShort(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

/** A display bar: a human label plus the event count it represents. */
type Bar = { label: string; count: number };

/**
 * Bucket a zero-filled daily series into consecutive 7-day windows, oldest
 * first. Each bucket sums its days so the 365-day trend renders as ~53 bars
 * instead of 365 hairline bars.
 */
function bucketWeekly(data: DailyEventCount[]): Bar[] {
  const bars: Bar[] = [];
  for (let i = 0; i < data.length; i += 7) {
    const week = data.slice(i, i + 7);
    if (!week.length) break;
    bars.push({
      label: `${formatDateShort(week[0].date)} – ${formatDateShort(week[week.length - 1].date)}`,
      count: week.reduce((sum, d) => sum + d.count, 0),
    });
  }
  return bars;
}

function Bars({ bars, ariaLabel }: { bars: Bar[]; ariaLabel: string }) {
  const max = Math.max(...bars.map((b) => b.count), 1);
  const barW = CHART_W / bars.length - BAR_GAP;

  return (
    <svg
      width="100%"
      viewBox={`0 0 ${CHART_W} ${CHART_H}`}
      style={{ display: "block", overflow: "visible" }}
      role="img"
      aria-label={ariaLabel}
    >
      {bars.map((b, i) => {
        const barH = Math.max(b.count > 0 ? 2 : 0, (b.count / max) * (CHART_H - 4));
        const x = i * (barW + BAR_GAP);
        const y = CHART_H - barH;
        return (
          <rect
            key={`${b.label}-${i}`}
            x={x}
            y={y}
            width={Math.max(barW, 1)}
            height={barH}
            fill="var(--accent, #58a6ff)"
            rx={1}
            role="img"
            aria-label={`${b.label}: ${b.count} event${b.count === 1 ? "" : "s"}`}
          >
            <title>
              {b.label}: {b.count} event{b.count === 1 ? "" : "s"}
            </title>
          </rect>
        );
      })}
    </svg>
  );
}

function RangeSelector({
  range,
  onRangeChange,
}: {
  range: StatsRange;
  onRangeChange: (range: StatsRange) => void;
}) {
  return (
    <div role="group" aria-label="Event volume time range" style={{ display: "flex", gap: 6 }}>
      {STATS_RANGE_OPTIONS.map((opt) => {
        const active = opt.days === range;
        return (
          <button
            key={opt.days}
            type="button"
            onClick={() => onRangeChange(opt.days)}
            aria-pressed={active}
            style={{
              padding: "4px 10px",
              fontSize: 12,
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: active ? "var(--accent, #58a6ff)" : "transparent",
              color: active ? "#fff" : "var(--muted)",
              cursor: "pointer",
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

export default function InvocationFrequencyChart({
  contractId,
  range = 30,
  onRangeChange,
}: {
  contractId: string;
  range?: StatsRange;
  onRangeChange?: (range: StatsRange) => void;
}) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["contract-stats", contractId, range],
    queryFn: () => api.contractStats(contractId, range),
    enabled: !!contractId,
  });

  if (isLoading) return <p style={{ color: "var(--muted)", fontSize: 13 }}>Loading activity…</p>;
  if (isError || !data) return null;

  const days = data.events_per_day;
  const hasActivity = days.some((d) => d.count > 0);

  // Daily bars up to 90 days; weekly buckets beyond so the trend stays readable.
  const bars = range > 90 ? bucketWeekly(days) : days.map((d) => ({ label: formatDateShort(d.date), count: d.count }));

  return (
    <div className="card" style={{ padding: "14px 16px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 12,
          flexWrap: "wrap",
        }}
      >
        <h3
          style={{
            fontSize: 13,
            color: "var(--muted)",
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            margin: 0,
          }}
        >
          Event Volume Trend (Last {range} Days)
        </h3>
        {onRangeChange && <RangeSelector range={range} onRangeChange={onRangeChange} />}
      </div>
      {hasActivity ? (
        <>
          <Bars
            bars={bars}
            ariaLabel={`Invocation frequency for the last ${range} days`}
          />
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: 11,
              color: "var(--muted)",
              marginTop: 6,
            }}
          >
            <span>{bars[0].label}</span>
            <span>{bars[bars.length - 1].label}</span>
          </div>
        </>
      ) : (
        <p style={{ color: "var(--muted)", fontSize: 13, margin: 0 }}>No activity in the last {range} days</p>
      )}
    </div>
  );
}
