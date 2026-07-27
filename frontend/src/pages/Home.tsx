import { useEffect, useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api } from "../api";
import type { DecodedEvent } from "../api";
import EventTable from "../components/EventTable";
import ExportButton from "../components/ExportButton";
import { useEventStream } from "../hooks/useEventStream";

const FUNCTIONS = ["", "swap", "transfer", "mint", "burn", "stake", "unstake", "wrap_native", "unwrap_native"];

// DEX-specific function chips shown when the active ?contract= is tagged
// protocol_type = "dex" (issue #555). Each value is the comma-separated list
// of exact function names passed to GET /api/events?fn=.
const DEX_FUNCTION_CHIPS = [
  { label: "All", fn: "" },
  { label: "Swap", fn: "swap,swap_exact_tokens_for_tokens" },
  { label: "Add Liquidity", fn: "add_liquidity,provide_liquidity" },
  { label: "Remove Liquidity", fn: "remove_liquidity,withdraw_liquidity" },
];

// transaction type filter
type TxType = "all" | "soroban" | "classic";

const TYPE_LABELS: { key: TxType; label: string; title: string }[] = [
  {
    key: "all",
    label: "All Transactions",
    title: "Show all transaction types",
  },
  {
    key: "soroban",
    label: "Soroban Only",
    title: "Contract deployments and invocations only",
  },
  {
    key: "classic",
    label: "Classic Operations Only",
    title: "Payments, offers, and other classic ops",
  },
];

export default function Home() {
  const [searchParams] = useSearchParams();
  const contractParam = searchParams.get("contract") ?? "";

  const [fnFilter, setFnFilter] = useState("");
  // Keyset pagination (#490): stack of after_seq cursors for the pages we've
  // navigated past — empty stack = first page, pop to go back.
  const [cursorStack, setCursorStack] = useState<number[]>([]);
  const [txType, setTxType] = useState<TxType>("all");
  const afterSeq = cursorStack.length ? cursorStack[cursorStack.length - 1] : undefined;

  // Reset filters when the active contract changes so a stale fn filter from
  // a previous contract doesn't silently carry over.
  useEffect(() => {
    setFnFilter("");
    setCursorStack([]);
  }, [contractParam]);

  const { data: filterContractMeta } = useQuery({
    queryKey: ["contract", contractParam],
    queryFn: () => api.contract(contractParam),
    enabled: !!contractParam,
    retry: false,
  });
  const isDexContract = filterContractMeta?.protocol_type === "dex";

  const queryClient = useQueryClient();
  const { data: eventsPage, isLoading } = useQuery({
    queryKey: ["events", contractParam, fnFilter, afterSeq ?? 0, txType],
    queryFn: () =>
      api.events({
        contract: contractParam || undefined,
        fn: fnFilter || undefined,
        after_seq: afterSeq,
        type: txType !== "all" ? txType : undefined,
      }),
  });
  const events = eventsPage?.data ?? [];
  const nextCursor = eventsPage?.next_cursor ?? null;

  // invalidate the event list when a live event arrives on the first page
  const handleLiveEvent = useCallback(
    (ev: DecodedEvent) => {
      if (
        cursorStack.length === 0 &&
        (!fnFilter || ev.function === fnFilter) &&
        (!contractParam || ev.contract_id === contractParam)
      ) {
        queryClient.invalidateQueries({ queryKey: ["events", contractParam, fnFilter, 0] });
      }
    },
    [contractParam, cursorStack.length, fnFilter, queryClient],
  );

  useEventStream(handleLiveEvent);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <h1 style={{ fontSize: 22, marginBottom: 4 }}>Soroban Smart Block Explorer</h1>
        <p style={{ color: "var(--muted)" }}>Human-readable Soroban contract events on Stellar.</p>
      </div>

      {/* Filters row */}
      <div
        style={{
          display: "flex",
          gap: 16,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        {/* type toggle */}
        <div
          style={{
            display: "flex",
            gap: 0,
            borderRadius: 6,
            overflow: "hidden",
            border: "1px solid var(--border)",
          }}
        >
          {TYPE_LABELS.map(({ key, label, title }) => (
            <button
              key={key}
              title={title}
              onClick={() => {
                setTxType(key);
                setCursorStack([]);
              }}
              style={{
                background: txType === key ? "var(--accent)" : "var(--surface)",
                color: txType === key ? "#0d1117" : "var(--muted)",
                borderRadius: 0,
                padding: "6px 14px",
                fontWeight: txType === key ? 700 : 400,
                borderRight: "1px solid var(--border)",
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Function filter — DEX-specific chips replace the generic dropdown
            when the active ?contract= is tagged protocol_type = "dex" (#555) */}
        {isDexContract ? (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <label style={{ color: "var(--muted)" }}>Function:</label>
            <div style={{ display: "flex", gap: 4 }}>
              {DEX_FUNCTION_CHIPS.map((chip) => (
                <button
                  key={chip.label}
                  onClick={() => {
                    setFnFilter(chip.fn);
                    setCursorStack([]);
                  }}
                  style={{
                    padding: "5px 12px",
                    borderRadius: 14,
                    border: "1px solid var(--border)",
                    background: fnFilter === chip.fn ? "var(--accent)" : "var(--surface)",
                    color: fnFilter === chip.fn ? "#0d1117" : "var(--muted)",
                    fontWeight: fnFilter === chip.fn ? 700 : 400,
                    fontSize: 12,
                  }}
                >
                  {chip.label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <label style={{ color: "var(--muted)" }}>Function:</label>
            <select
              value={fnFilter}
              onChange={(e) => {
                setFnFilter(e.target.value);
                setCursorStack([]);
              }}
            >
              {FUNCTIONS.map((f) => (
                <option key={f} value={f}>
                  {f || "All"}
                </option>
              ))}
            </select>
          </div>
        )}

        <ExportButton
          target="events"
          params={{
            contract: contractParam || undefined,
            fn: fnFilter || undefined,
            type: txType !== "all" ? txType : undefined,
          }}
        />
      </div>

      <div className="card">
        {isLoading ? <p style={{ color: "var(--muted)" }}>Loading…</p> : <EventTable events={events} />}
      </div>

      {/* Pagination */}
      <div style={{ display: "flex", gap: 8 }}>
        <button disabled={cursorStack.length === 0} onClick={() => setCursorStack((s) => s.slice(0, -1))}>
          ← Prev
        </button>
        <span style={{ padding: "6px 10px", color: "var(--muted)" }}>Page {cursorStack.length + 1}</span>
        <button
          disabled={nextCursor === null}
          onClick={() => {
            if (nextCursor !== null) setCursorStack((s) => [...s, nextCursor]);
          }}
        >
          Next →
        </button>
      </div>
    </div>
  );
}
