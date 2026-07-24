// Issue #210: Flamegraph rendering for sub-invocation call chains
// Mimics CPU profiler flamegraphs with gas-weighted bar widths.
// Pure SVG/CSS — no extra dependencies.
import { useMemo, useState } from "react";
import type { SubInvocationExtended } from "../api";

interface Props {
  invocations: SubInvocationExtended[];
  txHash?: string;
}

const DEPTH_COLORS = [
  "#6366f1",
  "#8b5cf6",
  "#a78bfa",
  "#c4b5fd",
  "#7c3aed",
  "#5b21b6",
  "#4c1d95",
];

const ROW_H = 24;
const ROW_GAP = 2;
const LABEL_PAD = 6;

function short(id: string) {
  return id.length > 14 ? `${id.slice(0, 7)}…${id.slice(-5)}` : id;
}

interface Flamebar {
  inv: SubInvocationExtended;
  x: number;
  width: number;
  depth: number;
}

function buildFlamebars(
  invocations: SubInvocationExtended[],
  totalWidth: number,
): Flamebar[] {
  if (!invocations.length) return [];

  // Group by tx_hash to build per-transaction trees
  const byTx = new Map<string, SubInvocationExtended[]>();
  for (const inv of invocations) {
    const bucket = byTx.get(inv.parent_tx_hash) ?? [];
    bucket.push(inv);
    byTx.set(inv.parent_tx_hash, bucket);
  }

  const allBars: Flamebar[] = [];
  const txCount = byTx.size;
  const txWidth = totalWidth / txCount;
  let txOffset = 0;

  for (const [, chain] of byTx) {
    const sorted = [...chain].sort((a, b) => a.depth - b.depth);
    const totalGas = sorted.reduce((s, i) => s + (i.fee_charged ?? 1), 0);

    // Group by depth level
    const byDepth = new Map<number, SubInvocationExtended[]>();
    for (const inv of sorted) {
      const arr = byDepth.get(inv.depth) ?? [];
      arr.push(inv);
      byDepth.set(inv.depth, arr);
    }

    for (const [depth, levelInvs] of byDepth) {
      let levelOffset = txOffset;
      for (const inv of levelInvs) {
        const gas = inv.fee_charged ?? 1;
        const w = Math.max(1, (gas / totalGas) * txWidth);
        allBars.push({ inv, x: levelOffset, width: w, depth });
        levelOffset += w;
      }
    }

    txOffset += txWidth;
  }

  return allBars;
}

export default function SubInvocationFlamegraph({ invocations, txHash }: Props) {
  const [tooltip, setTooltip] = useState<{ text: string; x: number; y: number } | null>(null);
  const [selected, setSelected] = useState<SubInvocationExtended | null>(null);

  const WIDTH = 800;
  const bars = useMemo(() => buildFlamebars(invocations, WIDTH), [invocations]);
  const maxDepth = useMemo(() => Math.max(0, ...invocations.map((i) => i.depth)), [invocations]);
  const totalHeight = (maxDepth + 1) * (ROW_H + ROW_GAP) + 16;

  if (!invocations.length) {
    return <p style={{ color: "var(--muted)", padding: 12 }}>No invocations to render.</p>;
  }

  return (
    <div className="card" style={{ padding: 0, overflowX: "auto" }}>
      <div
        style={{
          padding: "10px 16px",
          borderBottom: "1px solid var(--border)",
          fontSize: 13,
          fontWeight: 600,
        }}
      >
        Flamegraph{txHash ? ` — ${txHash.slice(0, 12)}…` : ""}
        <span style={{ fontSize: 11, color: "var(--muted)", marginLeft: 8, fontWeight: 400 }}>
          Bar width = gas cost · Depth = call depth
        </span>
      </div>
      <svg
        width={WIDTH}
        height={totalHeight}
        style={{ display: "block", minWidth: WIDTH }}
        aria-label="Sub-invocation flamegraph"
        onMouseLeave={() => setTooltip(null)}
      >
        {bars.map((bar, i) => {
          const y = bar.depth * (ROW_H + ROW_GAP) + 8;
          const color = DEPTH_COLORS[bar.depth % DEPTH_COLORS.length];
          const isSelected = selected?.id === bar.inv.id;
          return (
            <g
              key={i}
              style={{ cursor: "pointer" }}
              onClick={() => setSelected(bar.inv)}
              onMouseEnter={(e) => {
                const gas = bar.inv.fee_charged;
                setTooltip({
                  text: `${bar.inv.contract_id} · ${bar.inv.function}${gas != null ? ` · ${gas.toLocaleString()} gas` : ""}`,
                  x: e.nativeEvent.offsetX,
                  y: e.nativeEvent.offsetY,
                });
              }}
            >
              <rect
                x={bar.x}
                y={y}
                width={Math.max(1, bar.width - 1)}
                height={ROW_H}
                fill={color}
                opacity={isSelected ? 1 : 0.85}
                stroke={isSelected ? "#fff" : "none"}
                strokeWidth={isSelected ? 1.5 : 0}
                rx={2}
              />
              {bar.width > 40 && (
                <text
                  x={bar.x + LABEL_PAD}
                  y={y + ROW_H / 2 + 4}
                  fill="#fff"
                  fontSize={10}
                  fontFamily="monospace"
                  clipPath={`url(#clip-${i})`}
                >
                  {short(bar.inv.contract_id)}·{bar.inv.function}
                </text>
              )}
              <clipPath id={`clip-${i}`}>
                <rect x={bar.x} y={y} width={Math.max(1, bar.width - 2)} height={ROW_H} />
              </clipPath>
            </g>
          );
        })}
        {tooltip && (
          <g>
            <rect
              x={Math.min(tooltip.x + 8, WIDTH - 240)}
              y={tooltip.y - 26}
              width={232}
              height={22}
              rx={4}
              fill="rgba(0,0,0,0.85)"
            />
            <text
              x={Math.min(tooltip.x + 14, WIDTH - 234)}
              y={tooltip.y - 10}
              fill="#fff"
              fontSize={10}
              fontFamily="monospace"
            >
              {tooltip.text.length > 36 ? tooltip.text.slice(0, 36) + "…" : tooltip.text}
            </text>
          </g>
        )}
      </svg>
      {selected && (
        <div
          style={{
            padding: "8px 16px",
            borderTop: "1px solid var(--border)",
            fontSize: 12,
            display: "flex",
            gap: 16,
            flexWrap: "wrap",
          }}
        >
          <span>
            <strong>Contract:</strong> {selected.contract_id}
          </span>
          <span>
            <strong>Function:</strong> {selected.function}
          </span>
          <span>
            <strong>Depth:</strong> {selected.depth}
          </span>
          {selected.fee_charged != null && (
            <span>
              <strong>Gas:</strong> {selected.fee_charged.toLocaleString()}
            </span>
          )}
          <span>
            <strong>Ledger:</strong> {selected.ledger}
          </span>
        </div>
      )}
    </div>
  );
}
