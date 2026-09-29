/**
 * TTLProgressBar —
 * Renders a labelled progress bar for a single TTL entry (instance or code).
 * Shows remaining ledgers, estimated time, and expiration ledger number.
 */

import { useQuery } from "@tanstack/react-query";
import { api } from "../api";

export const SECS_PER_LEDGER = 5; // ~5 s per ledger on Stellar mainnet/testnet

export function formatRemaining(ledgers: number): string {
  const secs = ledgers * SECS_PER_LEDGER;
  const days = Math.floor(secs / 86400);
  const hours = Math.floor((secs % 86400) / 3600);
  const mins = Math.floor((secs % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function statusColor(pct: number): string {
  if (pct <= 0) return "#6b7280"; // expired — grey
  if (pct < 10) return "#ef4444"; // critical — red
  if (pct < 25) return "#f59e0b"; // warning — amber
  return "#10b981"; // healthy — green
}

export interface BarProps {
  label: string;
  liveUntilLedger: number | null;
  currentLedger: number;
}

export function Bar({ label, liveUntilLedger, currentLedger }: BarProps) {
  if (liveUntilLedger === null) {
    return (
      <div style={{ marginBottom: 12 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: 12,
            color: "var(--muted)",
            marginBottom: 4,
          }}
        >
          <span>{label}</span>
          <span>unavailable</span>
        </div>
        <div style={{ height: 6, background: "var(--border)", borderRadius: 3 }} />
      </div>
    );
  }

  const remaining = Math.max(0, liveUntilLedger - currentLedger);
  // Use a 3-month window (~1.5M ledgers) as the "full" reference for the bar
  const FULL_WINDOW = 1_555_200; // 90 days × 86400 s / 5 s per ledger
  const pct = Math.min(100, (remaining / FULL_WINDOW) * 100);
  const color = statusColor(pct);
  const isExpired = remaining === 0;

  return (
    <div style={{ marginBottom: 12 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 12,
          marginBottom: 4,
        }}
      >
        <span style={{ color: "var(--muted)" }}>{label}</span>
        <span style={{ color, fontWeight: 600 }}>
          {isExpired ? "Expired" : `${remaining.toLocaleString()} ledgers · ${formatRemaining(remaining)}`}
        </span>
      </div>
      <div
        style={{
          height: 6,
          background: "var(--border, #2a2a3e)",
          borderRadius: 3,
          overflow: "hidden",
        }}
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${label} TTL`}
      >
        <div
          style={{
            height: "100%",
            width: `${Math.max(isExpired ? 0 : 1, pct)}%`,
            background: color,
            borderRadius: 3,
            transition: "width 0.4s ease",
          }}
        />
      </div>
      <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 3 }}>
        Expires at ledger {liveUntilLedger.toLocaleString()}
      </div>
    </div>
  );
}

interface TTLProgressBarProps {
  contractId: string;
}

export default function TTLProgressBar({ contractId }: TTLProgressBarProps) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["contract-ttl", contractId],
    queryFn: () => api.contractTTL(contractId),
    refetchInterval: 30_000, // refresh every 30 s
    enabled: !!contractId,
  });

  if (isLoading) return <p style={{ color: "var(--muted)", fontSize: 13 }}>Loading TTL…</p>;
  if (isError || !data) return null;

  return (
    <div className="card" style={{ padding: "14px 16px" }} aria-label="Contract TTL status">
      <h3
        style={{
          fontSize: 13,
          marginBottom: 12,
          color: "var(--muted)",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}
      >
        TTL / Expiration
      </h3>
      <Bar label="Instance" liveUntilLedger={data.instance.live_until_ledger} currentLedger={data.current_ledger} />
      <Bar label="Code (WASM)" liveUntilLedger={data.code.live_until_ledger} currentLedger={data.current_ledger} />
      <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
        Current ledger: {data.current_ledger.toLocaleString()} · ~{SECS_PER_LEDGER}s per ledger
      </div>
    </div>
  );
}
