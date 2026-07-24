/**
 * Network Comparison Tool
 * Shows whether a contract is deployed on Mainnet, Testnet, and Futurenet,
 * highlighting version/WASM hash mismatches.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";

function StatusBadge({ deployed, error }: { deployed: boolean; error?: string }) {
  if (error) return <span style={{ color: "#ef4444", fontWeight: 600 }}>Error</span>;
  return deployed ? (
    <span style={{ color: "#22c55e", fontWeight: 600 }}>✓ Live</span>
  ) : (
    <span style={{ color: "var(--muted)" }}>✗ Not found</span>
  );
}

export default function NetworkComparison({ contractId }: { contractId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["network-comparison", contractId],
    queryFn: () => api.networkComparison(contractId),
    enabled: !!contractId,
  });
  const statuses = Array.isArray(data?.statuses) ? data.statuses : [];

  if (isLoading) return <p style={{ color: "var(--muted)" }}>Checking networks…</p>;
  if (error) return <p style={{ color: "#ef4444" }}>Failed to load network comparison.</p>;
  if (statuses.length === 0) {
    return (
      <div className="card" style={{ color: "var(--muted)", fontSize: 13 }}>
        <strong style={{ display: "block", color: "var(--text)", fontSize: 14, marginBottom: 6 }}>
          No network data available
        </strong>
        No deployment status was returned for this contract.
      </div>
    );
  }

  return (
    <div className="card">
      <h3 style={{ marginBottom: 12, fontSize: 14 }}>Network Deployment Status</h3>

      {data?.hasVersionMismatch && (
        <div
          style={{
            background: "rgba(239,68,68,0.1)",
            border: "1px solid #ef4444",
            borderRadius: 6,
            padding: "8px 12px",
            marginBottom: 12,
            fontSize: 13,
            color: "#ef4444",
          }}
        >
          ⚠ WASM hash mismatch detected across networks — contract versions differ.
        </div>
      )}

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr
              style={{
                borderBottom: "1px solid var(--border)",
                color: "var(--muted)",
              }}
            >
              <th style={th}>Network</th>
              <th style={th}>Status</th>
              <th style={th}>WASM Hash</th>
              <th style={th}>Balance</th>
            </tr>
          </thead>
          <tbody>
            {statuses.map((s) => (
              <tr key={s.network} style={{ borderBottom: "1px solid var(--border)" }}>
                <td style={td}>
                  <span style={{ textTransform: "capitalize", fontWeight: 500 }}>{s.network}</span>
                </td>
                <td style={td}>
                  <StatusBadge deployed={s.deployed} error={s.error} />
                </td>
                <td
                  style={{
                    ...td,
                    fontFamily: "monospace",
                    fontSize: 12,
                    color: "var(--muted)",
                  }}
                >
                  {s.wasmHash ? `${s.wasmHash.slice(0, 16)}…` : "—"}
                </td>
                <td style={td}>{s.balance ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const th: React.CSSProperties = {
  textAlign: "left",
  padding: "8px 12px",
  fontWeight: 500,
};
const td: React.CSSProperties = { padding: "10px 12px" };
