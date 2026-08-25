/**
 * Batch Multi-Call Constructor Interface
 * Add batch multi-call constructor interface improvements
 */

import React, { useState, useCallback } from "react";
import { api } from "../api";
import BatchFlowChart from "../components/BatchFlowChart";
import { BatchCall, ConflictDetection, ExecutionMode, StateDiffPreview } from "../types/batch";

interface SimResult {
  success: boolean;
  results?: {
    callId: string;
    success: boolean;
    returnValue?: string;
    error?: string;
    cost: { cpuInsns: number; memBytes: number };
  }[];
  totalGas?: { cpuInsns: number; memBytes: number; fee: number };
  estimates?: Array<{ callId: string; cpuInsns: number; memBytes: number; fee: number; error?: string }>;
  errors?: Array<{ callId: string; error: string }>;
  conflicts?: ConflictDetection[];
  stateDiffs?: StateDiffPreview[];
  optimizedOrder?: string[];
  error?: string;
}

const EXECUTION_MODES: ExecutionMode[] = ["sequential", "parallel", "hybrid", "batch"];

export default function BatchMultiCall() {
  const [calls, setCalls] = useState<BatchCall[]>([]);
  const [executionMode, setExecutionMode] = useState<ExecutionMode>("sequential");
  const [sourceAccount, setSourceAccount] = useState("");
  const [simResult, setSimResult] = useState<SimResult | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSimulate = useCallback(
    async (mode: ExecutionMode, batchCalls: BatchCall[]) => {
      if (!batchCalls.length) return;
      
      setLoading(true);
      setSimResult(null);
      
      try {
        const response = await fetch("/api/batch/simulate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            calls: batchCalls,
            sourceAccount: sourceAccount || "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
          }),
        });
        const data = await response.json();
        setSimResult(data);
      } catch (e: any) {
        setSimResult({ success: false, error: e.message });
      } finally {
        setLoading(false);
      }
    },
    [sourceAccount]
  );

  const handleEstimateGas = useCallback(async () => {
    if (!calls.length) return;
    
    setLoading(true);
    try {
      const response = await fetch("/api/batch/estimate-gas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ calls, sourceAccount }),
      });
      const data = await response.json();
      setSimResult({ success: true, totalGas: data.totalGas, estimates: data.estimates });
    } catch (e: any) {
      setSimResult({ success: false, error: e.message });
    } finally {
      setLoading(false);
    }
  }, [calls, sourceAccount]);

  const handleValidate = useCallback(async () => {
    if (!calls.length) return;
    
    setLoading(true);
    try {
      const response = await fetch("/api/batch/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ calls, sourceAccount }),
      });
      const data = await response.json();
      setSimResult({ success: data.valid, conflicts: data.conflicts, errors: data.errors });
    } catch (e: any) {
      setSimResult({ success: false, error: e.message });
    } finally {
      setLoading(false);
    }
  }, [calls, sourceAccount]);

  const handleOptimize = useCallback(async () => {
    if (!calls.length) return;
    
    setLoading(true);
    try {
      const response = await fetch("/api/batch/optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ calls, sourceAccount }),
      });
      const data = await response.json();
      setSimResult({ success: true, optimizedOrder: data.optimizedOrder });
    } catch (e: any) {
      setSimResult({ success: false, error: e.message });
    } finally {
      setLoading(false);
    }
  }, [calls, sourceAccount]);

  const exportAsHardhat = useCallback(() => {
    downloadText(api.exportBatchAsHardhat(calls), "batch-script.ts");
  }, [calls]);

  const exportAsCurl = useCallback(() => {
    downloadText(api.exportBatchAsCurl(calls, sourceAccount || undefined), "batch-request.json");
  }, [calls, sourceAccount]);

  const exportAsGraphQL = useCallback(() => {
    downloadText(api.exportBatchAsGraphQL(), "batch-mutation.graphql");
  }, []);

  const exportAsJson = useCallback(() => {
    downloadText(api.exportBatchAsJson(calls, sourceAccount || undefined), "batch.json");
  }, [calls, sourceAccount]);

  const exportAsFoundry = useCallback(() => {
    const script = `// Generated Foundry-style script for Soroban batch calls
// Note: Foundry is primarily for EVM; this is a Soroban-compatible script

${calls.map(
  (call, i) => `// Call ${i + 1}: ${call.functionName}
// contract.call("${call.functionName}", [${call.args.map((a) => `"${a.value}"`).join(", ")}]);`
).join("\n")}
`;
    downloadText(script, "batch-script.sol");
  }, [calls]);

  const exportAsCli = useCallback(() => {
    const script = `#!/bin/bash
# Generated Soroban CLI commands

${calls.map(
  (call) => `soroban contract invoke \\
  --id ${call.contractId} \\
  --function ${call.functionName}`
).join("\n\n")}
`;
    downloadText(script, "batch-script.sh");
  }, [calls]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div className="card">
        <h2 style={{ fontSize: 18, marginBottom: 12 }}>Batch Multi-Call Constructor</h2>
        
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 13, color: "var(--muted)", display: "block", marginBottom: 4 }}>
            Source Account (optional - uses default if empty)
          </label>
          <input
            type="text"
            value={sourceAccount}
            onChange={(e) => setSourceAccount(e.target.value)}
            placeholder="G... or leave empty for demo mode"
            style={{
              width: "100%",
              padding: "6px 10px",
              fontSize: 13,
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 4,
            }}
          />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 13, color: "var(--muted)", marginRight: 8 }}>
            Execution Mode:
          </label>
          <select
            value={executionMode}
            onChange={(e) => setExecutionMode(e.target.value as ExecutionMode)}
            style={{
              padding: "6px 10px",
              fontSize: 13,
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 4,
            }}
          >
            {EXECUTION_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {mode.charAt(0).toUpperCase() + mode.slice(1)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <BatchFlowChart
        initialCalls={calls}
        onCallsChange={setCalls}
        onSimulate={handleSimulate}
      />

      <div className="card" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button
          onClick={() => handleSimulate(executionMode, calls)}
          disabled={calls.length === 0 || loading}
          style={{
            padding: "8px 16px",
            fontSize: 13,
            background: calls.length > 0 ? "var(--accent)" : "var(--border)",
            border: "none",
            borderRadius: 4,
          }}
        >
          {loading ? "Simulating..." : "Simulate Batch"}
        </button>

        <button
          onClick={handleEstimateGas}
          disabled={calls.length === 0 || loading}
          style={{
            padding: "8px 16px",
            fontSize: 13,
            background: "var(--yellow)",
            border: "none",
            borderRadius: 4,
          }}
        >
          Estimate Gas
        </button>

        <button
          onClick={handleValidate}
          disabled={calls.length === 0 || loading}
          style={{
            padding: "8px 16px",
            fontSize: 13,
            background: "var(--green)",
            border: "none",
            borderRadius: 4,
          }}
        >
          Validate
        </button>

        <button
          onClick={handleOptimize}
          disabled={calls.length === 0 || loading}
          style={{
            padding: "8px 16px",
            fontSize: 13,
            background: "var(--muted)",
            border: "none",
            borderRadius: 4,
          }}
        >
          Optimize
        </button>
      </div>

      {simResult && (
        <div className="card" style={{ borderColor: simResult.success ? "var(--green)" : "#f85149" }}>
          <h3 style={{ fontSize: 14, marginBottom: 8 }}>
            {simResult.success ? "✓ Simulation Result" : "✗ Simulation Failed"}
          </h3>

          {simResult.error && (
            <p style={{ color: "#f85149", fontSize: 13, marginBottom: 8 }}>{simResult.error}</p>
          )}

          {simResult.totalGas && (
            <div style={{ display: "flex", gap: 24, marginBottom: 12 }}>
              <span>
                Total CPU: <strong>{simResult.totalGas.cpuInsns}</strong>
              </span>
              <span>
                Total Mem: <strong>{simResult.totalGas.memBytes}</strong>
              </span>
              <span>
                Min Fee: <strong>{simResult.totalGas.fee}</strong> stroops
              </span>
            </div>
          )}

          {simResult.conflicts && simResult.conflicts.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <h4 style={{ fontSize: 13, marginBottom: 4 }}>Storage Conflicts Detected</h4>
              {simResult.conflicts.map((c, i) => (
                <div key={i} style={{ fontSize: 12, color: "var(--muted)" }}>
                  Call {c.callId}: conflicts with {c.conflictingCalls.length} other call(s)
                </div>
              ))}
            </div>
          )}

          {simResult.optimizedOrder && (
            <div style={{ marginBottom: 12 }}>
              <h4 style={{ fontSize: 13, marginBottom: 4 }}>Optimized Order</h4>
              <code style={{ fontSize: 12 }}>{simResult.optimizedOrder.join(" → ")}</code>
            </div>
          )}

          {simResult.results && (
            <div>
              <h4 style={{ fontSize: 13, marginBottom: 4 }}>Per-Call Results</h4>
              {simResult.results.map((r, i) => (
                <div key={i} style={{ fontSize: 12, marginBottom: 4 }}>
                  <span style={{ color: r.success ? "var(--green)" : "#f85149" }}>
                    {r.success ? "✓" : "✗"} Call {r.callId}
                  </span>
                  {r.returnValue && <span style={{ marginLeft: 8 }}>→ {r.returnValue.slice(0, 20)}…</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="card">
        <h3 style={{ fontSize: 14, marginBottom: 8 }}>Export Options</h3>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={exportAsHardhat} disabled={calls.length === 0} style={{ fontSize: 12 }}>
            Export as Hardhat (.ts)
          </button>
          <button onClick={exportAsCurl} disabled={calls.length === 0} style={{ fontSize: 12 }}>
            Export request JSON
          </button>
          <button onClick={exportAsGraphQL} disabled={calls.length === 0} style={{ fontSize: 12 }}>
            Export as GraphQL
          </button>
          <button onClick={exportAsJson} disabled={calls.length === 0} style={{ fontSize: 12 }}>
            Export as JSON
          </button>
          <button onClick={exportAsFoundry} disabled={calls.length === 0} style={{ fontSize: 12 }}>
            Export as Foundry script
          </button>
          <button onClick={exportAsCli} disabled={calls.length === 0} style={{ fontSize: 12 }}>
            Export as CLI script
          </button>
        </div>
      </div>
    </div>
  );
}

function downloadText(content: string, filename: string) {
  const blob = new Blob([content], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}