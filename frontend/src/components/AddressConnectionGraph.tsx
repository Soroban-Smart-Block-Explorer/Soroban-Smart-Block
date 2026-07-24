/**
 * Interactive Address Connection Graph
 * Visual map of how a contract interacts with external addresses and other contracts.
 * Uses Cytoscape.js for interactive node-based graph rendering.
 */
import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";

export interface GraphNode {
  id: string;
  label: string;
  type: "contract" | "wallet";
}

export interface GraphEdge {
  source: string;
  target: string;
  label?: string;
  amount?: string;
}

export interface AddressGraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

interface Props {
  contractId: string;
}

export default function AddressConnectionGraph({ contractId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<any>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["address-graph", contractId],
    queryFn: () => api.addressGraph(contractId),
    enabled: !!contractId,
  });
  const nodes = Array.isArray(data?.nodes) ? data.nodes : [];
  const edges = Array.isArray(data?.edges) ? data.edges : [];

  useEffect(() => {
    if (!data || !containerRef.current) return;

    // Dynamically import cytoscape to avoid SSR issues
    import("cytoscape").then(({ default: cytoscape }) => {
      // Destroy previous instance
      if (cyRef.current) {
        cyRef.current.destroy();
      }

      const elements = [
        ...nodes.map((n) => ({
          data: {
            id: n.id,
            label: n.label.length > 12 ? `${n.label.slice(0, 6)}…${n.label.slice(-4)}` : n.label,
            type: n.type,
          },
        })),
        ...edges.map((e, i) => ({
          data: {
            id: `e${i}`,
            source: e.source,
            target: e.target,
            label: e.amount ? `${e.amount}` : (e.label ?? ""),
          },
        })),
      ];

      cyRef.current = cytoscape({
        container: containerRef.current,
        elements,
        style: [
          {
            selector: "node",
            style: {
              "background-color": "data(type)" as any,
              label: "data(label)",
              color: "#fff",
              "font-size": 10,
              "text-valign": "bottom",
              "text-margin-y": 4,
              width: 36,
              height: 36,
            },
          },
          {
            selector: 'node[type = "contract"]',
            style: { "background-color": "#6366f1" },
          },
          {
            selector: 'node[type = "wallet"]',
            style: { "background-color": "#0ea5e9" },
          },
          {
            selector: "edge",
            style: {
              width: 2,
              "line-color": "#4b5563",
              "target-arrow-color": "#4b5563",
              "target-arrow-shape": "triangle",
              "curve-style": "bezier",
              label: "data(label)",
              "font-size": 9,
              color: "#9ca3af",
              "text-rotation": "autorotate",
            },
          },
        ],
        layout: { name: "cose", padding: 30 } as any,
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
  }, [data]);

  if (isLoading) return <p style={{ color: "var(--muted)" }}>Loading graph…</p>;
  if (error) return <p style={{ color: "#ef4444" }}>Failed to load address graph.</p>;
  if (nodes.length === 0) {
    return (
      <div className="card" style={{ color: "var(--muted)", fontSize: 13 }}>
        <strong style={{ display: "block", color: "var(--text)", fontSize: 14, marginBottom: 6 }}>
          No address graph data available
        </strong>
        No wallet or contract connections were returned for this contract.
      </div>
    );
  }

  return (
    <div className="card">
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 12,
        }}
      >
        <h3 style={{ fontSize: 14, margin: 0 }}>Address Connection Graph</h3>
        <div
          style={{
            display: "flex",
            gap: 16,
            fontSize: 12,
            color: "var(--muted)",
          }}
        >
          <span>
            <span
              style={{
                display: "inline-block",
                width: 10,
                height: 10,
                borderRadius: "50%",
                background: "#6366f1",
                marginRight: 4,
              }}
            />
            Contract
          </span>
          <span>
            <span
              style={{
                display: "inline-block",
                width: 10,
                height: 10,
                borderRadius: "50%",
                background: "#0ea5e9",
                marginRight: 4,
              }}
            />
            Wallet
          </span>
        </div>
      </div>
      <div
        ref={containerRef}
        style={{
          width: "100%",
          height: 420,
          background: "var(--surface, #0f0f1a)",
          borderRadius: 8,
        }}
      />
      <p style={{ fontSize: 11, color: "var(--muted)", marginTop: 8 }}>
        Scroll to zoom · Drag to pan · {nodes.length} nodes · {edges.length} connections
      </p>
    </div>
  );
}
