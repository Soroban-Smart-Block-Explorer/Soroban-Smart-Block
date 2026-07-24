// Issue #210: Sub-invocation search with advanced query language and full-text search
// Supports 8+ filter types: of: fn: depth: gas: date: arg: reentrant: ledger: tx:
// Full-text decoded argument search with fuzzy matching and boolean operators.
import { useState, useMemo, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import type { SubInvocationExtended, SubInvocationFilter } from "../api";
import { parseQuery, filterToQuery, matchesArgQuery } from "../utils/subInvocationQuery";

const FILTER_HINTS = [
  { prefix: "of:", example: "of:CABC…", desc: "Sub-invocations of contract" },
  { prefix: "fn:", example: "fn:transfer", desc: "Function name" },
  { prefix: "depth:>", example: "depth:>3", desc: "Minimum call depth" },
  { prefix: "depth:<", example: "depth:<5", desc: "Maximum call depth" },
  { prefix: "gas:>", example: "gas:>50000", desc: "Minimum gas cost" },
  { prefix: "date:", example: "date:2024-01-01..2024-12-31", desc: "Date range" },
  { prefix: "arg:", example: "arg:amount>100", desc: "Argument value search" },
  { prefix: "reentrant:", example: "reentrant:true", desc: "Reentrancy filter" },
  { prefix: "ledger:>", example: "ledger:>1000000", desc: "Minimum ledger" },
  { prefix: "tx:", example: "tx:abc123…", desc: "Transaction hash" },
];

interface Props {
  onResultsChange?: (results: SubInvocationExtended[]) => void;
}

function FilterChip({
  label,
  value,
  onRemove,
}: {
  label: string;
  value: string;
  onRemove: () => void;
}) {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 8px",
        background: "rgba(99,102,241,0.12)",
        border: "1px solid rgba(99,102,241,0.35)",
        borderRadius: 12,
        fontSize: 11,
        color: "#a5b4fc",
        fontFamily: "monospace",
      }}
    >
      <span style={{ color: "var(--muted)" }}>{label}:</span>
      {value}
      <button
        onClick={onRemove}
        style={{
          background: "none",
          border: "none",
          cursor: "pointer",
          color: "var(--muted)",
          padding: 0,
          lineHeight: 1,
          fontSize: 12,
        }}
        aria-label={`Remove ${label} filter`}
      >
        ×
      </button>
    </div>
  );
}

function short(id: string) {
  return id.length > 14 ? `${id.slice(0, 7)}…${id.slice(-5)}` : id;
}

export default function SubInvocationSearch({ onResultsChange }: Props) {
  const [rawQuery, setRawQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [showHints, setShowHints] = useState(false);
  const [localArgFilter, setLocalArgFilter] = useState("");

  const parsedFilter: SubInvocationFilter = useMemo(
    () => parseQuery(submittedQuery),
    [submittedQuery],
  );

  const { data: results = [], isLoading, error } = useQuery({
    queryKey: ["sub-invocations-search", submittedQuery],
    queryFn: () => api.searchSubInvocations(parsedFilter),
    enabled: !!submittedQuery,
  });

  // Client-side full-text arg filter (for immediate UX, complements server filter)
  const filtered: SubInvocationExtended[] = useMemo(() => {
    if (!localArgFilter) return results;
    return results.filter((inv) => matchesArgQuery(inv, localArgFilter));
  }, [results, localArgFilter]);

  const handleSearch = useCallback(() => {
    setSubmittedQuery(rawQuery.trim());
    if (onResultsChange) onResultsChange([]);
  }, [rawQuery, onResultsChange]);

  // Notify parent when results change
  useMemo(() => {
    if (onResultsChange) onResultsChange(filtered);
  }, [filtered, onResultsChange]);

  const removeFilter = (key: keyof SubInvocationFilter) => {
    const next = { ...parsedFilter };
    delete next[key];
    const q = filterToQuery(next);
    setRawQuery(q);
    setSubmittedQuery(q);
  };

  const chips: { label: string; key: keyof SubInvocationFilter; value: string }[] = [];
  if (parsedFilter.contract) chips.push({ label: "of", key: "contract", value: short(parsedFilter.contract) });
  if (parsedFilter.function) chips.push({ label: "fn", key: "function", value: parsedFilter.function });
  if (parsedFilter.depth_min != null)
    chips.push({ label: "depth≥", key: "depth_min", value: String(parsedFilter.depth_min) });
  if (parsedFilter.depth_max != null)
    chips.push({ label: "depth≤", key: "depth_max", value: String(parsedFilter.depth_max) });
  if (parsedFilter.gas_min != null)
    chips.push({ label: "gas≥", key: "gas_min", value: parsedFilter.gas_min.toLocaleString() });
  if (parsedFilter.gas_max != null)
    chips.push({ label: "gas≤", key: "gas_max", value: parsedFilter.gas_max.toLocaleString() });
  if (parsedFilter.date_from)
    chips.push({ label: "from", key: "date_from", value: parsedFilter.date_from });
  if (parsedFilter.date_to)
    chips.push({ label: "to", key: "date_to", value: parsedFilter.date_to });
  if (parsedFilter.has_reentrancy != null)
    chips.push({ label: "reentrant", key: "has_reentrancy", value: String(parsedFilter.has_reentrancy) });
  if (parsedFilter.ledger_min != null)
    chips.push({ label: "ledger≥", key: "ledger_min", value: String(parsedFilter.ledger_min) });
  if (parsedFilter.tx_hash)
    chips.push({ label: "tx", key: "tx_hash", value: short(parsedFilter.tx_hash) });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Search bar */}
      <div className="card" style={{ padding: "12px 16px" }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>
          Sub-Invocation Search
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div style={{ flex: 1, position: "relative" }}>
            <input
              value={rawQuery}
              onChange={(e) => setRawQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              onFocus={() => setShowHints(true)}
              onBlur={() => setTimeout(() => setShowHints(false), 150)}
              placeholder='of:CONTRACT fn:transfer depth:>2 gas:>50000 reentrant:true …'
              aria-label="Sub-invocation search query"
              style={{
                width: "100%",
                padding: "8px 12px",
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                color: "var(--text)",
                fontFamily: "monospace",
                fontSize: 12,
                boxSizing: "border-box",
              }}
            />
            {showHints && (
              <div
                style={{
                  position: "absolute",
                  top: "100%",
                  left: 0,
                  right: 0,
                  background: "var(--bg, #0a0a16)",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  zIndex: 100,
                  boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
                  maxHeight: 240,
                  overflowY: "auto",
                }}
              >
                {FILTER_HINTS.map((h) => (
                  <button
                    key={h.prefix}
                    onMouseDown={() => {
                      setRawQuery((q) => (q ? `${q} ${h.example}` : h.example));
                    }}
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      gap: 8,
                      width: "100%",
                      padding: "6px 12px",
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      textAlign: "left",
                      color: "var(--text)",
                    }}
                  >
                    <code style={{ fontSize: 11, color: "#a5b4fc", flexShrink: 0 }}>{h.example}</code>
                    <span style={{ fontSize: 11, color: "var(--muted)" }}>{h.desc}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={handleSearch}
            disabled={isLoading}
            style={{
              padding: "8px 18px",
              background: "var(--accent)",
              color: "#fff",
              border: "none",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: 13,
              flexShrink: 0,
            }}
          >
            {isLoading ? "…" : "Search"}
          </button>
        </div>

        {/* Active filter chips */}
        {chips.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
            {chips.map((c) => (
              <FilterChip
                key={c.key}
                label={c.label}
                value={c.value}
                onRemove={() => removeFilter(c.key)}
              />
            ))}
          </div>
        )}
      </div>

      {error && (
        <p style={{ color: "#ef4444", fontSize: 12 }}>
          Search failed — check the query or try again.
        </p>
      )}

      {/* Client-side full-text search */}
      {results.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            value={localArgFilter}
            onChange={(e) => setLocalArgFilter(e.target.value)}
            placeholder="Full-text filter decoded args (fuzzy, boolean: AND / OR, ranges: amount>100)…"
            aria-label="Full-text argument filter"
            style={{
              flex: 1,
              padding: "6px 12px",
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              color: "var(--text)",
              fontFamily: "monospace",
              fontSize: 12,
            }}
          />
          {localArgFilter && (
            <span style={{ fontSize: 11, color: "var(--muted)" }}>
              {filtered.length}/{results.length}
            </span>
          )}
        </div>
      )}

      {/* Results table */}
      {filtered.length > 0 && (
        <div className="card" style={{ padding: 0, overflowX: "auto" }}>
          <div
            style={{
              padding: "8px 16px",
              borderBottom: "1px solid var(--border)",
              fontSize: 12,
              color: "var(--muted)",
              display: "flex",
              justifyContent: "space-between",
            }}
          >
            <span>{filtered.length} results</span>
            {localArgFilter && <span>Filtered by: &ldquo;{localArgFilter}&rdquo;</span>}
          </div>
          <table
            style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}
            aria-label="Sub-invocation search results"
          >
            <thead>
              <tr
                style={{
                  fontSize: 11,
                  color: "var(--muted)",
                  borderBottom: "1px solid var(--border)",
                }}
              >
                <th style={{ padding: "6px 12px", textAlign: "left" }}>Contract</th>
                <th style={{ padding: "6px 12px", textAlign: "left" }}>Function</th>
                <th style={{ padding: "6px 12px", textAlign: "center" }}>Depth</th>
                <th style={{ padding: "6px 12px", textAlign: "right" }}>Gas</th>
                <th style={{ padding: "6px 12px", textAlign: "right" }}>Ledger</th>
                <th style={{ padding: "6px 12px", textAlign: "left" }}>Tx Hash</th>
                <th style={{ padding: "6px 12px", textAlign: "left" }}>Args</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((inv) => (
                <tr
                  key={inv.id}
                  style={{ borderTop: "1px solid var(--border)" }}
                >
                  <td
                    style={{
                      padding: "5px 12px",
                      fontFamily: "monospace",
                      fontSize: 11,
                    }}
                  >
                    {short(inv.contract_id)}
                    {inv.has_reentrancy && (
                      <span
                        title="Reentrancy"
                        style={{ marginLeft: 4, color: "#ef4444", fontSize: 10 }}
                      >
                        ⚠
                      </span>
                    )}
                  </td>
                  <td style={{ padding: "5px 12px" }}>{inv.function}</td>
                  <td style={{ padding: "5px 12px", textAlign: "center" }}>{inv.depth}</td>
                  <td style={{ padding: "5px 12px", textAlign: "right" }}>
                    {inv.fee_charged != null ? inv.fee_charged.toLocaleString() : "—"}
                  </td>
                  <td style={{ padding: "5px 12px", textAlign: "right" }}>{inv.ledger}</td>
                  <td
                    style={{
                      padding: "5px 12px",
                      fontFamily: "monospace",
                      fontSize: 10,
                      color: "var(--muted)",
                    }}
                  >
                    {short(inv.parent_tx_hash)}
                  </td>
                  <td
                    style={{
                      padding: "5px 12px",
                      fontFamily: "monospace",
                      fontSize: 10,
                      color: "var(--muted)",
                      maxWidth: 200,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={JSON.stringify(inv.args)}
                  >
                    {inv.args != null ? JSON.stringify(inv.args) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {submittedQuery && !isLoading && results.length === 0 && (
        <p style={{ color: "var(--muted)", fontSize: 12 }}>
          No sub-invocations matched your query.
        </p>
      )}
    </div>
  );
}
