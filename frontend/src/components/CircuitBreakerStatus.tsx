import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api";

interface CircuitBreakerStatusProps {
  contractId: string;
}

const STATUS_COLORS: Record<string, { bg: string; border: string; text: string; icon: string }> = {
  OPEN: { bg: "rgba(239, 68, 68, 0.1)", border: "#ef4444", text: "#dc2626", icon: "⛔" },
  "HALF-OPEN": { bg: "rgba(245, 158, 11, 0.1)", border: "#f59e0b", text: "#b45309", icon: "◐" },
  CLOSED: { bg: "rgba(34, 197, 94, 0.1)", border: "#22c55e", text: "#16a34a", icon: "✓" },
};

export default function CircuitBreakerStatus({ contractId }: CircuitBreakerStatusProps) {
  const { data: status, isLoading } = useQuery({
    queryKey: ["circuit-breaker", contractId],
    queryFn: () => api.circuitBreakerStatus(contractId),
    enabled: !!contractId,
  });

  if (isLoading) {
    return <div style={{ color: "var(--muted)", fontSize: 13 }}>Loading status…</div>;
  }

  if (!status?.has_circuit_breaker) {
    return null;
  }

  const colors = STATUS_COLORS[status.status] ?? STATUS_COLORS.CLOSED;
  const statusText = status.status === "OPEN" ? "Circuit breaker tripped" : `Status: ${status.status}`;

  return (
    <div
      style={{
        background: colors.bg,
        border: `2px solid ${colors.border}`,
        borderRadius: 8,
        padding: "12px 16px",
        marginBottom: 16,
        display: "flex",
        alignItems: "center",
        gap: 12,
      }}
    >
      <span style={{ fontSize: 20 }}>{colors.icon}</span>
      <div style={{ flex: 1 }}>
        <div style={{ color: colors.text, fontWeight: 700, fontSize: 14 }}>{statusText}</div>
        <div style={{ color: "var(--muted)", fontSize: 12, marginTop: 4, display: "flex", gap: 12, flexWrap: "wrap" }}>
          {status.pause_status_ledger != null && <span>Last status change at ledger {status.pause_status_ledger}</span>}
          {status.trigger_threshold != null && <span>Trip threshold: {status.trigger_threshold}</span>}
          <span>
            Auto-reset:{" "}
            {status.auto_reset_at ? new Date(status.auto_reset_at).toLocaleString() : "manual reset required"}
          </span>
        </div>
        {status.pause_trigger_event_seq != null && (
          <div style={{ marginTop: 6 }}>
            <Link
              to={`/event/${status.pause_trigger_event_seq}`}
              style={{ color: colors.text, fontSize: 12, fontWeight: 600 }}
            >
              View trigger event
              {status.pause_trigger_tx_hash ? ` (tx ${status.pause_trigger_tx_hash.slice(0, 10)}…)` : ""} →
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
