// State Archival / Restore Operation display

interface RevivedKey {
  type: string;
  label: string;
  contractId?: string;
  wasmHash?: string;
  dataKey?: string;
  durability?: string;
}

interface RestoreInfo {
  isRestoreOp: boolean;
  revivedKeys: RevivedKey[];
  keyCount: number;
  feePaid: number | null;
}

interface Props {
  restore: RestoreInfo;
}

const TYPE_COLORS: Record<string, string> = {
  contractInstance: "#6366f1",
  contractData: "#0ea5e9",
  contractCode: "#8b5cf6",
  account: "#10b981",
  trustline: "#f59e0b",
};

export default function RestoreFootprintPanel({ restore }: Props) {
  if (!restore.isRestoreOp || restore.keyCount === 0) return null;

  return (
    <div
      className="card"
      style={{ borderLeft: "4px solid #6366f1", padding: "12px 16px" }}
      aria-label="State Restoration Operation"
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 12,
        }}
      >
        <span
          style={{
            background: "#6366f1",
            color: "#fff",
            borderRadius: 4,
            padding: "2px 8px",
            fontSize: 12,
            fontWeight: 700,
            letterSpacing: 0.5,
          }}
        >
          State Restoration (RestoreFootprintOp)
        </span>
        <span style={{ color: "var(--muted)", fontSize: 13 }}>
          {restore.keyCount} ledger key{restore.keyCount !== 1 ? "s" : ""} revived from archive
        </span>
        {restore.feePaid != null && (
          <span style={{ marginLeft: "auto", color: "var(--muted)", fontSize: 12 }}>
            Fee paid: <strong>{restore.feePaid.toLocaleString()} stroops</strong>
          </span>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {restore.revivedKeys.map((key, i) => {
          const color = TYPE_COLORS[key.type] ?? "var(--muted)";
          return (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "6px 10px",
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                fontSize: 13,
              }}
            >
              <span
                style={{
                  background: color,
                  color: "#fff",
                  borderRadius: 3,
                  padding: "1px 6px",
                  fontSize: 11,
                  fontWeight: 600,
                  whiteSpace: "nowrap",
                }}
              >
                {key.type}
              </span>
              <span
                style={{
                  fontFamily: "monospace",
                  color: "var(--text)",
                  wordBreak: "break-all",
                }}
              >
                {key.label}
              </span>
              {key.durability && (
                <span
                  style={{
                    marginLeft: "auto",
                    color: "var(--muted)",
                    fontSize: 11,
                  }}
                >
                  {key.durability}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
