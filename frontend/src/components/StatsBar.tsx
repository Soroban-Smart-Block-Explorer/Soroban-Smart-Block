import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api";

function formatCount(n: number | null): string {
  if (n === null) return "—";
  return n.toLocaleString();
}

function formatRate(n: number | null, digits = 1): string {
  if (n === null) return "—";
  return n.toFixed(digits);
}

interface StatItemProps {
  to: string;
  label: string;
  value: string;
  title: string;
  /** true for server-rendered routes (e.g. /api/docs) outside the SPA router — needs a full navigation, not client-side routing. */
  external?: boolean;
}

function StatItem({ to, label, value, title, external }: StatItemProps) {
  const linkStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "baseline",
    gap: 6,
    color: "inherit",
    textDecoration: "none",
    whiteSpace: "nowrap",
  };
  const content = (
    <>
      <span style={{ fontSize: 13, fontWeight: 700 }}>{value}</span>
      <span style={{ fontSize: 12, color: "var(--muted)" }}>{label}</span>
    </>
  );

  if (external) {
    return (
      <a href={to} title={title} style={linkStyle}>
        {content}
      </a>
    );
  }

  return (
    <Link to={to} title={title} style={linkStyle}>
      {content}
    </Link>
  );
}

/**
 * Compact home-page stats bar — polls GET /api/health every 10s and
 * surfaces indexer health at a glance. Hidden below 768px (see the
 * .stats-bar media query) since there isn't room for it alongside the
 * mobile nav and filters.
 */
export default function StatsBar() {
  const { data } = useQuery({
    queryKey: ["health-stats"],
    queryFn: () => api.health(),
    refetchInterval: 10_000,
    staleTime: 5_000,
  });

  const stats = data?.stats;

  return (
    <>
      <style>{`
        @media (max-width: 768px) {
          .stats-bar {
            display: none;
          }
        }
      `}</style>
      <div
        className="stats-bar card"
        style={{
          display: "flex",
          gap: 24,
          alignItems: "center",
          flexWrap: "wrap",
          padding: "8px 16px",
        }}
      >
        <StatItem
          to="/contracts"
          label="events indexed"
          value={formatCount(stats?.total_events ?? null)}
          title="Total events indexed — browse the contract registry"
        />
        <StatItem
          to="/api/docs"
          label="events/min"
          value={formatRate(stats?.events_per_minute ?? null)}
          title="Events indexed per minute (5-minute rolling average) — API docs"
        />
        <StatItem
          to="/rpc-metrics"
          label="ledgers behind"
          value={formatCount(stats?.indexer_lag_ledgers ?? null)}
          title="Indexer lag in ledgers — RPC metrics dashboard"
        />
        <StatItem
          to="/api/docs"
          label="decode success"
          value={stats?.decode_success_rate != null ? `${formatRate(stats.decode_success_rate)}%` : "—"}
          title="Share of events successfully decoded — API docs"
        />
      </div>
    </>
  );
}
