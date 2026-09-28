import { useEffect, useState, useCallback, useRef } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api } from "../api";
import type { DecodedEvent } from "../api";
import EventTable from "../components/EventTable";
import ExportButton from "../components/ExportButton";
import SkeletonLoader from "../components/SkeletonLoader";
import StatsBar from "../components/StatsBar";
import LatestLedgers from "../components/LatestLedgers";
import { useEventStream } from "../hooks/useEventStream";
import { useMetaTags } from "../hooks/useMetaTags";

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
  useMetaTags({
    title: "Soroban Smart Block Explorer — Decode Stellar contract events",
    description: "Soroban Smart Block Explorer — Decode Stellar contract events",
  });

  const [searchParams, setSearchParams] = useSearchParams();
  const contractParam = searchParams.get("contract") ?? "";

  const [fnFilter, setFnFilter] = useState(searchParams.get("fn") ?? "");
  const [txType, setTxType] = useState<TxType>(
    searchParams.get("type") === "soroban" || searchParams.get("type") === "classic"
      ? (searchParams.get("type") as TxType)
      : "all",
  );
  const [fromDate, setFromDate] = useState(searchParams.get("from") ?? "");
  const [toDate, setToDate] = useState(searchParams.get("to") ?? "");
  const previousContract = useRef(contractParam);

  const updateView = useCallback(
    (updates: Record<string, string | undefined>) => {
      setSearchParams((current) => {
        const next = new URLSearchParams(current);
        for (const [key, value] of Object.entries(updates)) {
          if (value) next.set(key, value);
          else next.delete(key);
        }
        return next;
      });
    },
    [setSearchParams],
  );

  // Reset filters when the active contract changes so a stale fn filter from
  // a previous contract doesn't silently carry over.
  useEffect(() => {
    if (previousContract.current === contractParam) return;
    previousContract.current = contractParam;
    setFnFilter("");
    updateView({ fn: undefined });
  }, [contractParam, updateView]);

  const { data: filterContractMeta } = useQuery({
    queryKey: ["contract", contractParam],
    queryFn: () => api.contract(contractParam),
    enabled: !!contractParam,
    retry: false,
  });
  const isDexContract = filterContractMeta?.protocol_type === "dex";

  const queryClient = useQueryClient();
  const {
    data: eventsPages,
    isLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ["events", contractParam, fnFilter, txType, fromDate, toDate],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) =>
      api.events({
        contract: contractParam || undefined,
        fn: fnFilter || undefined,
        after_seq: pageParam,
        type: txType !== "all" ? txType : undefined,
        from: fromDate || undefined,
        to: toDate || undefined,
        limit: 100,
      }),
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
  });
  const events = eventsPages?.pages.flatMap((page) => page.data) ?? [];

  // invalidate the event list when a live event arrives on the first page
  const handleLiveEvent = useCallback(
    (ev: DecodedEvent) => {
      if (
        !fromDate &&
        (!fnFilter || ev.function === fnFilter) &&
        (!contractParam || ev.contract_id === contractParam)
      ) {
        queryClient.invalidateQueries({ queryKey: ["events", contractParam] });
      }
      const latest = queryClient.getQueryData<{ data: { ledger: number }[] }>(["ledgers", "latest"]);
      if (ev.ledger > (latest?.data[0]?.ledger ?? 0)) {
        queryClient.invalidateQueries({ queryKey: ["ledgers", "latest"] });
      }
    },
    [contractParam, fnFilter, fromDate, queryClient],
  );

  useEventStream(handleLiveEvent);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <StatsBar />
      <LatestLedgers />

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
                updateView({ type: key === "all" ? undefined : key });
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
                    updateView({ fn: chip.fn || undefined });
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
                updateView({ fn: e.target.value || undefined });
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

        <label style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "var(--muted)" }}>
          Jump to date:
          <input
            type="date"
            value={fromDate && fromDate === toDate ? fromDate : ""}
            onChange={(event) => {
              const date = event.target.value;
              setFromDate(date);
              setToDate(date);
              updateView({ from: date || undefined, to: date || undefined });
            }}
            aria-label="Jump to date"
          />
        </label>

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
        {isLoading ? (
          <SkeletonLoader />
        ) : (
          <EventTable
            events={events}
            onReachEnd={hasNextPage && !isFetchingNextPage ? () => void fetchNextPage() : undefined}
          />
        )}
      </div>

      {/* Pagination */}
      <div style={{ display: "flex", gap: 8 }}>
        <button disabled>
          ← Prev
        </button>
        <span style={{ padding: "6px 10px", color: "var(--muted)" }}>{events.length} events loaded</span>
        <button
          disabled={!hasNextPage || isFetchingNextPage}
          onClick={() => void fetchNextPage()}
        >
          {isFetchingNextPage ? "Loading…" : "Next →"}
        </button>
      </div>
    </div>
  );
}
