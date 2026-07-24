// Contract execution simulation estimator button
import { useState } from "react";

interface SimResult {
  success: boolean;
  returnValue?: string;
  cost?: { cpuInsns: string; memBytes: string };
  error?: string;
}

interface Props {
  contractId: string;
  fnName: string;
  args?: string; // JSON array string
}

export default function SimulateButton({ contractId, fnName, args = "[]" }: Props) {
  const [result, setResult] = useState<SimResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [argsInput, setArgsInput] = useState(args);

  async function simulate() {
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch("/api/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contractId,
          fn: fnName,
          args: JSON.parse(argsInput),
        }),
      });
      const data = await res.json();
      setResult(data);
    } catch (e: any) {
      setResult({ success: false, error: e.message });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <input
          value={argsInput}
          onChange={(e) => setArgsInput(e.target.value)}
          placeholder='Args JSON, e.g. ["GABC...", 100]'
          style={{ flex: 1, minWidth: 200 }}
        />
        <button onClick={simulate} disabled={loading} style={{ background: "var(--yellow)", color: "#0d1117" }}>
          {loading ? "Simulating…" : "⚡ Simulate Call"}
        </button>
      </div>

      {result && (
        <div
          className="card"
          style={{
            borderColor: result.success ? "var(--green)" : "#f85149",
            padding: "12px 16px",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: result.cost ? 10 : 0,
            }}
          >
            <span
              style={{
                fontWeight: 700,
                color: result.success ? "var(--green)" : "#f85149",
              }}
            >
              {result.success ? "✓ Would succeed" : "✗ Would revert"}
            </span>
            {result.returnValue && <code style={{ color: "var(--muted)", fontSize: 12 }}>→ {result.returnValue}</code>}
          </div>
          {result.error && <p style={{ color: "#f85149", fontSize: 12, marginTop: 4 }}>{result.error}</p>}
          {result.cost && (
            <div
              style={{
                display: "flex",
                gap: 16,
                fontSize: 12,
                color: "var(--muted)",
              }}
            >
              <span>
                CPU: <strong style={{ color: "var(--text)" }}>{result.cost.cpuInsns}</strong> insns
              </span>
              <span>
                Mem: <strong style={{ color: "var(--text)" }}>{result.cost.memBytes}</strong> bytes
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
