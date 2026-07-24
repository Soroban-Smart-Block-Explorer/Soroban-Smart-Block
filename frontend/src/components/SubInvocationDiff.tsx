// Issue #210: Side-by-side transaction tree comparison with gas cost visualization
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import type { SubInvocationExtended } from "../api";

function short(id: string) {
  return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id;
}

function InvocationRow({
  inv,
  variant,
}: {
  inv: SubInvocationExtended;
  variant: "only-a" | "only-b" | "common";
}) {
  const bg =
    variant === "only-a"
      ? "rgba(239,68,68,0.08)"
      : variant === "only-b"
        ? "rgba(34,197,94,0.08)"
        : "transparent";
  const marker =
    variant === "only-a" ? "−" : variant === "only-b" ? "+" : "=";
  const markerColor =
    variant === "only-a" ? "#ef4444" : variant === "only-b" ? "#22c55e" : "var(--muted)";

  return (
    <tr style={{ background: bg, fontSize: 11 }}>
      <td style={{ padding: "3px 8px", color: markerColor, fontWeight: 700 }}>{marker}</td>
      <td style={{ padding: "3px 8px", fontFamily: "monospace" }}>
        {short(inv.contract_id)}
      </td>
      <td style={{ padding: "3px 8px" }}>{inv.function}</td>
      <td style={{ padding: "3px 8px", textAlign: "center" }}>{inv.depth}</td>
      <td style={{ padding: "3px 8px", textAlign: "right" }}>
        {inv.fee_charged != null ? inv.fee_charged.toLocaleString() : "—"}
      </td>
    </tr>
  );
}

interface LocalDiff {
  tx_a: string;
  tx_b: string;
  only_in_a: SubInvocationExtended[];
  only_in_b: SubInvocationExtended[];
  common: SubInvocationExtended[];
  gas_diff: number;
}

function diffInvocations(
  a: SubInvocationExtended[],
  b: SubInvocationExtended[],
): LocalDiff {
  const keyOf = (i: SubInvocationExtended) => `${i.contract_id}:${i.function}:${i.depth}`;
  const aKeys = new Set(a.map(keyOf));
  const bKeys = new Set(b.map(keyOf));

  const only_in_a = a.filter((i) => !bKeys.has(keyOf(i)));
  const only_in_b = b.filter((i) => !aKeys.has(keyOf(i)));
  const common = a.filter((i) => bKeys.has(keyOf(i)));

  const gasA = a.reduce((s, i) => s + (i.fee_charged ?? 0), 0);
  const gasB = b.reduce((s, i) => s + (i.fee_charged ?? 0), 0);

  return {
    tx_a: a[0]?.parent_tx_hash ?? "",
    tx_b: b[0]?.parent_tx_hash ?? "",
    only_in_a,
    only_in_b,
    common,
    gas_diff: gasB - gasA,
  };
}

export default function SubInvocationDiff() {
  const [txA, setTxA] = useState("");
  const [txB, setTxB] = useState("");
  const [submitted, setSubmitted] = useState<{ a: string; b: string } | null>(null);

  const { data: aInvs, isLoading: aLoading } = useQuery({
    queryKey: ["sub-invocations", submitted?.a],
    queryFn: () => api.subInvocations(submitted!.a),
    enabled: !!submitted?.a,
  });

  const { data: bInvs, isLoading: bLoading } = useQuery({
    queryKey: ["sub-invocations", submitted?.b],
    queryFn: () => api.subInvocations(submitted!.b),
    enabled: !!submitted?.b,
  });

  const diff: LocalDiff | null =
    aInvs && bInvs ? diffInvocations(aInvs as SubInvocationExtended[], bInvs as SubInvocationExtended[]) : null;

  const loading = aLoading || bLoading;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="card">
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>
          Compare Transaction Call Trees
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <label style={{ fontSize: 11, color: "var(--muted)", display: "block", marginBottom: 4 }}>
              Transaction A
            </label>
            <input
              value={txA}
              onChange={(e) => setTxA(e.target.value)}
              placeholder="tx hash A…"
              style={{
                width: "100%",
                padding: "6px 10px",
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                color: "var(--text)",
                fontFamily: "monospace",
                fontSize: 12,
                boxSizing: "border-box",
              }}
            />
          </div>
          <div style={{ flex: 1, minWidth: 200 }}>
            <label style={{ fontSize: 11, color: "var(--muted)", display: "block", marginBottom: 4 }}>
              Transaction B
            </label>
            <input
              value={txB}
              onChange={(e) => setTxB(e.target.value)}
              placeholder="tx hash B…"
              style={{
                width: "100%",
                padding: "6px 10px",
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                color: "var(--text)",
                fontFamily: "monospace",
                fontSize: 12,
                boxSizing: "border-box",
              }}
            />
          </div>
          <button
            disabled={!txA.trim() || !txB.trim() || loading}
            onClick={() => setSubmitted({ a: txA.trim(), b: txB.trim() })}
            style={{
              padding: "6px 16px",
              background: "var(--accent)",
              color: "#fff",
              border: "none",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: 13,
              opacity: !txA.trim() || !txB.trim() ? 0.5 : 1,
            }}
          >
            Compare
          </button>
        </div>
      </div>

      {loading && <p style={{ color: "var(--muted)" }}>Loading invocations…</p>}

      {diff && (
        <>
          {/* Summary banner */}
          <div
            style={{
              display: "flex",
              gap: 16,
              padding: "10px 16px",
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              fontSize: 12,
            }}
          >
            <span style={{ color: "#ef4444" }}>
              − {diff.only_in_a.length} only in A
            </span>
            <span style={{ color: "#22c55e" }}>
              + {diff.only_in_b.length} only in B
            </span>
            <span style={{ color: "var(--muted)" }}>
              = {diff.common.length} common
            </span>
            {diff.gas_diff !== 0 && (
              <span style={{ color: diff.gas_diff > 0 ? "#ef4444" : "#22c55e", marginLeft: "auto" }}>
                Gas diff: {diff.gas_diff > 0 ? "+" : ""}
                {diff.gas_diff.toLocaleString()}
              </span>
            )}
          </div>

          {/* Diff table */}
          <div className="card" style={{ padding: 0, overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ fontSize: 11, color: "var(--muted)", borderBottom: "1px solid var(--border)" }}>
                  <th style={{ padding: "6px 8px", textAlign: "left" }}></th>
                  <th style={{ padding: "6px 8px", textAlign: "left" }}>Contract</th>
                  <th style={{ padding: "6px 8px", textAlign: "left" }}>Function</th>
                  <th style={{ padding: "6px 8px", textAlign: "center" }}>Depth</th>
                  <th style={{ padding: "6px 8px", textAlign: "right" }}>Gas</th>
                </tr>
              </thead>
              <tbody>
                {diff.only_in_a.map((inv, i) => (
                  <InvocationRow key={`a-${i}`} inv={inv} variant="only-a" />
                ))}
                {diff.common.map((inv, i) => (
                  <InvocationRow key={`c-${i}`} inv={inv} variant="common" />
                ))}
                {diff.only_in_b.map((inv, i) => (
                  <InvocationRow key={`b-${i}`} inv={inv} variant="only-b" />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
