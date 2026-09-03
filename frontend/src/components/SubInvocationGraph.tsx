// Issue #210: Interactive force-directed graph for sub-invocation call chains
// Uses Cytoscape.js (already a project dependency) with cose force layout.
// Nodes = contracts (sized by call frequency, coloured by type).
// Edges = invocations between contracts.
import { useEffect, useRef } from "react";
import type { Core } from "cytoscape";
import type { SubInvocationExtended } from "../api";

interface Props {
  invocations: SubInvocationExtended[];
}

const CONTRACT_TYPE_COLORS: Record<string, string> = {
  token: "#6366f1",
  dex: "#f59e0b",
  lending: "#10b981",
  nft: "#ec4899",
  other: "#6b7280",
};

function short(id: string) {
  return id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

export default function SubInvocationGraph({ invocations }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);

  useEffect(() => {
    if (!containerRef.current || invocations.length === 0) return;

    import("cytoscape").then(({ default: cytoscape }) => {
      if (cyRef.current) {
        cyRef.current.destroy();
      }

      // Build node call-count map
      const callCount = new Map<string, number>();
      for (const inv of invocations) {
        callCount.set(inv.contract_id, (callCount.get(inv.contract_id) ?? 0) + 1);
      }

      // Build edges from adjacent depth-pairs within the same tx
      const byTx = new Map<string, SubInvocationExtended[]>();
      for (const inv of invocations) {
        const bucket = byTx.get(inv.parent_tx_hash) ?? [];
        bucket.push(inv);
        byTx.set(inv.parent_tx_hash, bucket);
      }

      const edgeSet = new Map<string, number>();
      for (const [, chain] of byTx) {
        const sorted = [...chain].sort((a, b) => a.depth - b.depth);
        for (let i = 1; i < sorted.length; i++) {
          const src = sorted[i - 1].contract_id;
          const tgt = sorted[i].contract_id;
          if (src !== tgt) {
            const key = `${src}→${tgt}`;
            edgeSet.set(key, (edgeSet.get(key) ?? 0) + 1);
          }
        }
      }

      const uniqueContracts = [...callCount.keys()];
      const elements = [
        ...uniqueContracts.map((id) => ({
          data: {
            id,
            label: short(id),
            count: callCount.get(id) ?? 1,
            contractType: invocations.find((i) => i.contract_id === id)?.contract_type ?? "other",
          },
        })),
        ...[...edgeSet.entries()].map(([key, weight], idx) => {
          const [source, target] = key.split("→");
          return { data: { id: `e${idx}`, source, target, weight } };
        }),
      ];

      cyRef.current = cytoscape({
        container: containerRef.current,
        elements,
        style: [
          {
            selector: "node",
            style: {
              label: "data(label)",
              "background-color": CONTRACT_TYPE_COLORS.other,
              color: "#fff",
              "font-size": 10,
              "text-valign": "bottom",
              "text-margin-y": 4,
              width: "mapData(count, 1, 20, 28, 72)",
              height: "mapData(count, 1, 20, 28, 72)",
            },
          },
          ...Object.entries(CONTRACT_TYPE_COLORS).map(([type, color]) => ({
            selector: `node[contractType = "${type}"]`,
            style: { "background-color": color },
          })),
          {
            selector: "edge",
            style: {
              width: "mapData(weight, 1, 10, 1, 5)",
              "line-color": "#4b5563",
              "target-arrow-color": "#4b5563",
              "target-arrow-shape": "triangle",
              "curve-style": "bezier",
            },
          },
        ],
        layout: { name: "cose", padding: 32, animate: false },
        userZoomingEnabled: true,
        userPanningEnabled: true,
      });
    });

    return () => {
      if (cyRef.current) {
        cyRef.current.destroy();
        cyRef.current = null;
      }
    };
  }, [invocations]);

  if (invocations.length === 0) {
    return <p style={{ color: "var(--muted)", padding: 12 }}>No invocations to graph.</p>;
  }

  const uniqueContracts = new Set(invocations.map((i) => i.contract_id)).size;

  return (
    <div className="card" style={{ padding: 0 }}>
      <div
        style={{
          padding: "10px 16px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600 }}>Force-Directed Call Graph</span>
        <div style={{ display: "flex", gap: 12, fontSize: 11, color: "var(--muted)" }}>
          {Object.entries(CONTRACT_TYPE_COLORS).map(([type, color]) => (
            <span key={type}>
              <span
                style={{
                  display: "inline-block",
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: color,
                  marginRight: 4,
                }}
              />
              {type}
            </span>
          ))}
        </div>
      </div>
      <div
        ref={containerRef}
        style={{
          width: "100%",
          height: 440,
          background: "var(--surface, #0f0f1a)",
          borderRadius: "0 0 8px 8px",
        }}
      />
      <p style={{ fontSize: 11, color: "var(--muted)", padding: "4px 16px 8px" }}>
        Scroll to zoom · Drag to pan · {uniqueContracts} contracts · {invocations.length} invocations
        · Node size = call frequency
      </p>
    </div>
  );
}
