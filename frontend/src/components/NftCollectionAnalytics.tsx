/**
 * NftCollectionAnalytics — collection-level analytics for an NFT collection
 * (issue #810): mint volume over time and a unique-holder-count trend,
 * backed by GET /api/tokens/:contractId/nfts/analytics. Plain SVG, no chart
 * library — same convention as ContractStatsWidget / InvocationFrequencyChart.
 */
import { useQuery } from "@tanstack/react-query";
import { api, type NftAnalyticsPoint } from "../api";

const CHART_W = 600;
const CHART_H = 110;
const BAR_GAP = 2;

function formatDateShort(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

/** Bar chart of daily mint counts. */
function MintBars({ data }: { data: NftAnalyticsPoint[] }) {
  const max = Math.max(...data.map((d) => d.count), 1);
  const barW = CHART_W / data.length - BAR_GAP;

  return (
    <svg
      width="100%"
      viewBox={`0 0 ${CHART_W} ${CHART_H}`}
      style={{ display: "block", overflow: "visible" }}
      role="img"
      aria-label="NFT mint volume for the last 30 days"
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
            aria-label={`${formatDateShort(d.date)}: ${d.count} mint${d.count === 1 ? "" : "s"}`}
          >
            <title>
              {formatDateShort(d.date)}: {d.count} mint{d.count === 1 ? "" : "s"}
            </title>
          </rect>
        );
      })}
    </svg>
  );
}

/** Line chart of the cumulative unique-holder curve. */
function HolderLine({ data }: { data: NftAnalyticsPoint[] }) {
  const max = Math.max(...data.map((d) => d.count), 1);
  const pts = data
    .map((d, i) => {
      const x = (i / (data.length - 1 || 1)) * CHART_W;
      const y = CHART_H - (d.count / max) * (CHART_H - 4) - 2;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <svg
      width="100%"
      viewBox={`0 0 ${CHART_W} ${CHART_H}`}
      style={{ display: "block", overflow: "visible" }}
      role="img"
      aria-label="Unique holders over the last 30 days"
    >
      <polyline
        points={pts}
        fill="none"
        stroke="var(--accent, #58a6ff)"
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {data.map((d, i) => {
        const x = (i / (data.length - 1 || 1)) * CHART_W;
        const y = CHART_H - (d.count / max) * (CHART_H - 4) - 2;
        return (
          <circle key={d.date} cx={x} cy={y} r={2} fill="var(--accent, #58a6ff)">
            <title>
              {formatDateShort(d.date)}: {d.count} holder{d.count === 1 ? "" : "s"}
            </title>
          </circle>
        );
      })}
    </svg>
  );
}

function ChartHeader({ title }: { title: string }) {
  return (
    <h3
      style={{
        fontSize: 13,
        marginBottom: 12,
        color: "var(--muted)",
        textTransform: "uppercase",
        letterSpacing: "0.05em",
      }}
    >
      {title}
    </h3>
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

export default function NftCollectionAnalytics({ contractId }: { contractId: string }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["nft-analytics", contractId],
    queryFn: () => api.nftAnalytics(contractId, 30),
    enabled: !!contractId,
  });

  if (isLoading) return <p style={{ color: "var(--muted)", fontSize: 13 }}>Loading analytics…</p>;
  if (isError || !data) return null;

  const mintDays = data.mint_volume;
  const holderDays = data.holder_count;
  const hasMints = mintDays.some((d) => d.count > 0);
  const hasHolders = holderDays.some((d) => d.count > 0);

  return (
    <div className="card" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "flex", gap: 32, flexWrap: "wrap" }}>
        <Stat label="Total Minted" value={data.totals.minted.toLocaleString()} />
        <Stat label="Transfers" value={data.totals.transfers.toLocaleString()} />
        <Stat label="Unique Holders" value={data.totals.unique_holders.toLocaleString()} />
      </div>

      <div>
        <ChartHeader title={`Mint Volume (Last ${data.days} Days)`} />
        {hasMints ? (
          <>
            <MintBars data={mintDays} />
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: 11,
                color: "var(--muted)",
                marginTop: 6,
              }}
            >
              <span>{formatDateShort(mintDays[0].date)}</span>
              <span>{formatDateShort(mintDays[mintDays.length - 1].date)}</span>
            </div>
          </>
        ) : (
          <p style={{ color: "var(--muted)", fontSize: 13, margin: 0 }}>No mints in the last {data.days} days</p>
        )}
      </div>

      <div>
        <ChartHeader title={`Unique Holders (Last ${data.days} Days)`} />
        {hasHolders ? (
          <>
            <HolderLine data={holderDays} />
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: 11,
                color: "var(--muted)",
                marginTop: 6,
              }}
            >
              <span>{formatDateShort(holderDays[0].date)}</span>
              <span>{formatDateShort(holderDays[holderDays.length - 1].date)}</span>
            </div>
          </>
        ) : (
          <p style={{ color: "var(--muted)", fontSize: 13, margin: 0 }}>
            No holders recorded in the last {data.days} days
          </p>
        )}
      </div>
    </div>
  );
}
