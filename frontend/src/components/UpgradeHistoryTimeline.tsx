/**
 * Contract Upgrade History Timeline
 *
 * Vertical timeline of WASM upgrade events (function = 'upgrade'), showing
 * ledger, date, and the old→new hash transition for each upgrade.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { truncateAddress } from "../utils/strkey";

interface Props {
  contractId: string;
}

export default function UpgradeHistoryTimeline({ contractId }: Props) {
  const { data: upgrades = [], isLoading } = useQuery({
    queryKey: ["upgrade-history", contractId],
    queryFn: () => api.upgradeHistory(contractId),
    enabled: !!contractId,
  });

  if (isLoading) return <p style={{ color: "var(--muted)" }}>Loading upgrade history…</p>;

  if (upgrades.length === 0) {
    return (
      <div className="card" style={{ color: "var(--muted)", fontSize: 13 }}>
        No upgrades detected — this contract has not been upgraded since indexing began.
      </div>
    );
  }

  return (
    <div className="card">
      <h3 style={{ fontSize: 14, marginBottom: 16 }}>Upgrade History</h3>
      <div style={{ display: "flex", flexDirection: "column" }}>
        {upgrades.map((u, i) => (
          <div key={`${u.ledger}-${i}`} style={{ display: "flex", gap: 12 }}>
            {/* Timeline rail */}
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 12 }}>
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  background: "var(--accent, #7c3aed)",
                  flexShrink: 0,
                }}
              />
              {i < upgrades.length - 1 && (
                <span style={{ flex: 1, width: 2, background: "var(--border)", minHeight: 32 }} />
              )}
            </div>

            <div style={{ paddingBottom: 20, fontSize: 13 }}>
              <div style={{ fontWeight: 600 }}>
                Ledger {u.ledger.toLocaleString()}
                <span style={{ color: "var(--muted)", fontWeight: 400, marginLeft: 8 }}>
                  {new Date(u.timestamp).toLocaleString()}
                </span>
              </div>
              <div style={{ marginTop: 4, fontFamily: "monospace", color: "var(--muted)" }}>
                {u.old_hash ? truncateAddress(u.old_hash, 8, 6) : "unknown"}
                {" → "}
                <span style={{ color: "var(--fg)" }}>{u.new_hash ? truncateAddress(u.new_hash, 8, 6) : "unknown"}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
