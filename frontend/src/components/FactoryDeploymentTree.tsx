// Factory Deployment Trace: Multi-Contract Composite Deployments

import { Link } from "react-router-dom";

interface DeployedContract {
  contractId: string;
  wasmHash?: string | null;
  deploymentMethod?: string;
  index: number;
}

interface FactoryDeployment {
  factoryContractId: string | null;
  contracts: DeployedContract[];
}

interface Props {
  deployment: FactoryDeployment;
}

function short(id: string | null | undefined) {
  if (!id) return "unknown";
  return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id;
}

function DeploymentMethodBadge({ method }: { method?: string }) {
  if (!method || method === "unknown") return null;

  const colors: Record<string, { bg: string; text: string }> = {
    wasm_hash: { bg: "rgba(88,166,255,0.15)", text: "#58a6ff" },
    stellar_asset: { bg: "rgba(163,113,247,0.15)", text: "#a371f7" },
  };

  const color = colors[method] ?? {
    bg: "rgba(139,148,158,0.15)",
    text: "#8b949e",
  };

  return (
    <span
      style={{
        background: color.bg,
        color: color.text,
        border: `1px solid ${color.text}`,
        borderRadius: 3,
        padding: "1px 6px",
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: 0.3,
      }}
      title={method === "wasm_hash" ? "Deployed from pre-uploaded WASM hash" : "Stellar Asset Contract"}
    >
      {method === "wasm_hash" ? "WASM" : method === "stellar_asset" ? "SAC" : method.toUpperCase()}
    </span>
  );
}

export default function FactoryDeploymentTree({ deployment }: Props) {
  const { factoryContractId, contracts } = deployment;

  return (
    <div
      className="card"
      style={{
        borderLeft: "4px solid #d2a8ff",
        padding: "16px 20px",
        background: "rgba(210,168,255,0.05)",
      }}
      aria-label="Factory Deployment Trace"
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 16,
        }}
      >
        <span
          style={{
            background: "#d2a8ff",
            color: "#0d1117",
            borderRadius: 4,
            padding: "3px 10px",
            fontSize: 12,
            fontWeight: 700,
            letterSpacing: 0.5,
          }}
        >
          ⬢ FACTORY DEPLOYMENT TRACE
        </span>
        <span style={{ color: "var(--muted)", fontSize: 13 }}>
          {contracts.length} contract{contracts.length !== 1 ? "s" : ""} deployed in single transaction
        </span>
      </div>

      {/* Factory root node */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "10px 14px",
            background: "var(--surface)",
            border: "2px solid #d2a8ff",
            borderRadius: 8,
            fontFamily: "monospace",
            fontSize: 13,
          }}
        >
          <span style={{ color: "#d2a8ff", fontWeight: 700, fontSize: 14 }}>⬡ Factory Contract</span>
          {factoryContractId ? (
            <Link
              to={`/contract/${factoryContractId}`}
              style={{
                color: "var(--accent)",
                textDecoration: "none",
                fontWeight: 600,
              }}
              title={factoryContractId}
            >
              {short(factoryContractId)}
            </Link>
          ) : (
            <span style={{ color: "var(--muted)" }}>unknown</span>
          )}
        </div>

        {/* Deployed sub-contracts */}
        <div
          style={{
            marginLeft: 32,
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          {contracts.map((c, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 14px",
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                fontFamily: "monospace",
                fontSize: 12,
                transition: "border-color 0.2s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = "#d2a8ff";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = "var(--border)";
              }}
            >
              <span style={{ color: "var(--muted)", fontSize: 14 }}>└─</span>
              <span style={{ color: "var(--text)", fontWeight: 600, minWidth: 80 }}>Contract #{c.index + 1}</span>

              <Link
                to={`/contract/${c.contractId}`}
                style={{
                  color: "var(--accent)",
                  textDecoration: "none",
                  fontWeight: 600,
                }}
                title={c.contractId}
              >
                {short(c.contractId)}
              </Link>

              <DeploymentMethodBadge method={c.deploymentMethod} />

              {c.wasmHash && (
                <span
                  style={{
                    marginLeft: "auto",
                    color: "var(--muted)",
                    fontSize: 11,
                    fontFamily: "monospace",
                  }}
                  title={`WASM Hash: ${c.wasmHash}`}
                >
                  {c.wasmHash.slice(0, 8)}…
                </span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Footer note */}
      <div
        style={{
          marginTop: 12,
          padding: "8px 12px",
          background: "rgba(210,168,255,0.08)",
          borderRadius: 4,
          fontSize: 11,
          color: "var(--muted)",
          fontStyle: "italic",
        }}
      >
        💡 This transaction executed a factory pattern, programmatically deploying multiple contracts from a single
        parent contract. Click any contract ID to view its profile.
      </div>
    </div>
  );
}
