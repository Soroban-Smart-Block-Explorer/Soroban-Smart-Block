/**
 * Visual State-Diff Timeline for Smart Contracts
 *
 * Renders an interactive timeline slider that lets users scrub through
 * historical ContractDataEntry mutations block-by-block.
 */

import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import type { StateDiff } from "../api";

interface Props {
  contractId: string;
}

const CHANGE_COLORS: Record<string, string> = {
  created: "var(--green, #22c55e)",
  updated: "var(--accent, #7c3aed)",
  removed: "var(--red, #ef4444)",
};

export default function StateDiffTimeline({ contractId }: Props) {
  const [sliderIndex, setSliderIndex] = useState(0);
  const [filterKey, setFilterKey] = useState("");

  const { data: diffResponse = [], isLoading } = useQuery({
    queryKey: ["state-diffs", contractId],
    queryFn: () => api.stateDiffs(contractId),
    enabled: !!contractId,
  });
  const diffs = Array.isArray(diffResponse) ? diffResponse : [];

  // Group diffs by ledger, sorted ascending
  const ledgerGroups = useMemo(() => {
    const map = new Map<number, StateDiff[]>();
    for (const d of diffs) {
      const arr = map.get(d.ledger) ?? [];
      arr.push(d);
      map.set(d.ledger, arr);
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a - b)
      .map(([ledger, entries]) => ({ ledger, entries }));
  }, [diffs]);

  const uniqueKeys = useMemo(() => {
    const s = new Set(diffs.map((d) => d.key));
    return Array.from(s).sort();
  }, [diffs]);

  const maxIndex = ledgerGroups.length - 1;
  const safeSliderIndex = Math.min(sliderIndex, Math.max(maxIndex, 0));
  const current = ledgerGroups[safeSliderIndex];
  const visibleEntries = current ? (filterKey ? current.entries.filter((e) => e.key === filterKey) : current.entries) : [];

  // Cumulative state up to current ledger for context
  const cumulativeState = useMemo(() => {
    const state: Record<string, string | null> = {};
    for (let i = 0; i <= safeSliderIndex && i < ledgerGroups.length; i++) {
      const group = ledgerGroups[i];
      if (!group) continue;
      for (const d of group.entries) {
        state[d.key] = d.new_value;
      }
    }
    return state;
  }, [ledgerGroups, safeSliderIndex]);

  if (isLoading) return <p style={{ color: "var(--muted)" }}>Loading state diffs…</p>;

  if (!current) {
    return (
      <div className="card" style={{ color: "var(--muted)", fontSize: 13 }}>
        No storage state changes recorded for this contract yet.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Slider control */}
      <div className="card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 600 }}>Block {current.ledger.toLocaleString()}</span>
          <span style={{ fontSize: 12, color: "var(--muted)" }}>
            {safeSliderIndex + 1} / {ledgerGroups.length} snapshots
          </span>
        </div>

        <input
          type="range"
          min={0}
          max={maxIndex}
          value={safeSliderIndex}
          onChange={(e) => setSliderIndex(Number(e.target.value))}
          style={{ width: "100%", accentColor: "var(--accent)" }}
          aria-label="Timeline slider — scrub through block history"
        />

        {/* Mini timeline ticks */}
        <div style={{ display: "flex", gap: 2, height: 6, alignItems: "flex-end" }}>
          {ledgerGroups.map((g, i) => (
            <div
              key={g.ledger}
              onClick={() => setSliderIndex(i)}
              title={`Ledger ${g.ledger} — ${g.entries.length} change${g.entries.length !== 1 ? "s" : ""}`}
              style={{
                flex: 1,
                height: Math.min(6, 2 + g.entries.length),
                background:
                  i === safeSliderIndex ? "var(--accent)" : i < safeSliderIndex ? "var(--muted)" : "var(--border)",
                borderRadius: 2,
                cursor: "pointer",
                transition: "background 0.15s",
              }}
            />
          ))}
        </div>
      </div>

      {/* Key filter */}
      {uniqueKeys.length > 1 && (
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontSize: 12, color: "var(--muted)" }}>Filter key:</span>
          <button
            onClick={() => setFilterKey("")}
            style={{
              padding: "3px 10px",
              fontSize: 11,
              background: !filterKey ? "var(--accent)" : "var(--surface)",
              color: !filterKey ? "#fff" : "var(--muted)",
              border: "1px solid var(--border)",
              borderRadius: 12,
              cursor: "pointer",
            }}
          >
            All
          </button>
          {uniqueKeys.map((k) => (
            <button
              key={k}
              onClick={() => setFilterKey(k === filterKey ? "" : k)}
              style={{
                padding: "3px 10px",
                fontSize: 11,
                background: filterKey === k ? "var(--accent)" : "var(--surface)",
                color: filterKey === k ? "#fff" : "var(--muted)",
                border: "1px solid var(--border)",
                borderRadius: 12,
                cursor: "pointer",
                maxWidth: 160,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={k}
            >
              {k.length > 20 ? k.slice(0, 18) + "…" : k}
            </button>
          ))}
        </div>
      )}

      {/* Changes at current ledger */}
      <div className="card" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <h4 style={{ fontSize: 13, margin: 0, marginBottom: 4 }}>
          Changes at ledger {current.ledger.toLocaleString()}
          {current.entries[0]?.tx_hash && (
            <span
              style={{
                fontSize: 11,
                color: "var(--muted)",
                marginLeft: 8,
                fontWeight: 400,
              }}
            >
              tx: {current.entries[0].tx_hash.slice(0, 12)}…
            </span>
          )}
        </h4>

        {visibleEntries.length === 0 ? (
          <p style={{ color: "var(--muted)", fontSize: 12 }}>No changes for this key at this ledger.</p>
        ) : (
          visibleEntries.map((d, i) => (
            <div
              key={i}
              style={{
                display: "grid",
                gridTemplateColumns: "auto 1fr 1fr",
                gap: "6px 12px",
                padding: "8px 12px",
                background: "var(--bg)",
                border: `1px solid ${CHANGE_COLORS[d.change_type] ?? "var(--border)"}22`,
                borderLeft: `3px solid ${CHANGE_COLORS[d.change_type] ?? "var(--border)"}`,
                borderRadius: 6,
                fontSize: 12,
              }}
            >
              <span
                style={{
                  color: CHANGE_COLORS[d.change_type],
                  fontWeight: 700,
                  textTransform: "uppercase",
                  fontSize: 10,
                  alignSelf: "center",
                }}
              >
                {d.change_type}
              </span>
              <div
                style={{
                  gridColumn: "2 / -1",
                  fontFamily: "monospace",
                  color: "var(--fg)",
                  wordBreak: "break-all",
                }}
              >
                {d.key}
              </div>
              {d.change_type !== "created" && d.old_value !== null && (
                <div
                  style={{
                    gridColumn: "2",
                    color: "var(--red, #ef4444)",
                    fontFamily: "monospace",
                    wordBreak: "break-all",
                  }}
                >
                  − {d.old_value}
                </div>
              )}
              {d.change_type !== "removed" && d.new_value !== null && (
                <div
                  style={{
                    gridColumn: d.change_type === "created" ? "2 / -1" : "3",
                    color: "var(--green, #22c55e)",
                    fontFamily: "monospace",
                    wordBreak: "break-all",
                  }}
                >
                  + {d.new_value}
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* Cumulative state snapshot */}
      <details
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: "10px 16px",
        }}
      >
        <summary
          style={{
            cursor: "pointer",
            fontSize: 12,
            color: "var(--muted)",
            userSelect: "none",
          }}
        >
          Cumulative state at ledger {current.ledger.toLocaleString()} ({Object.keys(cumulativeState).length} keys)
        </summary>
        <div
          style={{
            marginTop: 10,
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          {Object.entries(cumulativeState).map(([k, v]) => (
            <div
              key={k}
              style={{
                display: "flex",
                gap: 8,
                fontSize: 11,
                fontFamily: "monospace",
              }}
            >
              <span
                style={{
                  color: "var(--muted)",
                  minWidth: 120,
                  wordBreak: "break-all",
                }}
              >
                {k}
              </span>
              <span style={{ color: "var(--fg)", wordBreak: "break-all" }}>{v ?? "(removed)"}</span>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
