/**
 * StorageTierStackedBar — horizontal stacked bar summarizing a contract's
 * storage writes by durability tier, backed by GET /api/contracts/:id/storage-tiers.
 */
import { useQuery } from "@tanstack/react-query";
import { api, type StorageTierCounts } from "../api";

const TIERS: {
  key: keyof StorageTierCounts;
  label: string;
  color: string;
  describe: (n: number) => string;
}[] = [
  {
    key: "persistent",
    label: "Persistent",
    color: "#3fb950",
    describe: (n) => `${n} persistent write${n === 1 ? "" : "s"} — these survive ledger archival`,
  },
  {
    key: "temporary",
    label: "Temporary",
    color: "#d29922",
    describe: (n) => `${n} temporary write${n === 1 ? "" : "s"} — evicted once their TTL expires`,
  },
  {
    key: "instance",
    label: "Instance",
    color: "#58a6ff",
    describe: (n) => `${n} instance write${n === 1 ? "" : "s"} — contract configuration state`,
  },
];

export default function StorageTierStackedBar({ contractId }: { contractId: string }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["contract-storage-tiers", contractId],
    queryFn: () => api.contractStorageTiers(contractId),
    enabled: !!contractId,
  });

  if (isLoading) return <p style={{ color: "var(--muted)", fontSize: 13 }}>Loading storage breakdown…</p>;
  if (isError || !data) return null;

  const total = TIERS.reduce((sum, t) => sum + data[t.key], 0);

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
        Storage Writes by Tier
      </h3>
      {total === 0 ? (
        <p style={{ color: "var(--muted)", fontSize: 13, margin: 0 }}>No storage writes recorded yet</p>
      ) : (
        <>
          <div
            style={{
              display: "flex",
              width: "100%",
              height: 16,
              borderRadius: 4,
              overflow: "hidden",
              background: "var(--border)",
            }}
            role="img"
            aria-label={`Storage writes by tier: ${TIERS.map((t) => `${data[t.key]} ${t.label.toLowerCase()}`).join(", ")}`}
          >
            {TIERS.map((t) => {
              const count = data[t.key];
              if (count === 0) return null;
              const pct = (count / total) * 100;
              return (
                <div
                  key={t.key}
                  title={t.describe(count)}
                  style={{
                    width: `${pct}%`,
                    background: t.color,
                    height: "100%",
                  }}
                />
              );
            })}
          </div>

          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 10 }}>
            {TIERS.map((t) => {
              const count = data[t.key];
              return (
                <div
                  key={t.key}
                  title={t.describe(count)}
                  style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      background: t.color,
                      flexShrink: 0,
                    }}
                  />
                  <span style={{ color: "var(--text)" }}>{t.label}</span>
                  <span style={{ color: "var(--muted)" }}>({count})</span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
