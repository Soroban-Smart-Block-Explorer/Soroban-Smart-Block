import { useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import type { DecodedEvent } from "../api";
import EventTable from "../components/EventTable";

const VALID_ADDRESS_RE = /^G[A-Z2-7]{55}$/;

export default function WalletPage() {
  const { address = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const [copied, setCopied] = useState(false);

  // All filter state lives in the URL — the source of truth is read directly
  // from searchParams on every render, so a shared link always restores the
  // exact same view (#533).
  const fromLedger = searchParams.get("from") ?? "";
  const toLedger = searchParams.get("to") ?? "";
  const fnFilter = searchParams.get("fn") ?? "";
  const groupBy = (searchParams.get("group") === "function" ? "function" : "none") as GroupBy;

  const isValidAddress = VALID_ADDRESS_RE.test(address);

  const { data, isLoading } = useQuery({
    queryKey: ["wallet", address],
    queryFn: () => api.wallet(address),
    enabled: !!address && isValidAddress,
  });
  const events = data?.events ?? [];

  const availableFunctions = useMemo(
    () => Array.from(new Set(events.map((ev) => ev.function))).sort(),
    [events],
  );

  const filtered = useMemo(() => {
    const from = fromLedger ? Number(fromLedger) : null;
    const to = toLedger ? Number(toLedger) : null;
    return events.filter((ev) => {
      if (from != null && !isNaN(from) && ev.ledger < from) return false;
      if (to != null && !isNaN(to) && ev.ledger > to) return false;
      if (fnFilter && ev.function !== fnFilter) return false;
      return true;
    });
  }, [events, fromLedger, toLedger, fnFilter]);

  const groups = useMemo(() => {
    if (groupBy !== "function") return null;
    const byFn = new Map<string, DecodedEvent[]>();
    for (const ev of filtered) {
      if (!byFn.has(ev.function)) byFn.set(ev.function, []);
      byFn.get(ev.function)!.push(ev);
    }
    return [...byFn.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [filtered, groupBy]);

  function updateParam(key: string, value: string) {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { replace: true });
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable — silently ignore */
    }
  }

  const events = data?.events ?? [];
  const horizonAccount = data?.horizon_account ?? null;
  const xlmBalance = horizonAccount?.balances?.find((b) => b.asset_type === "native");

  if (address && !isValidAddress) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <div className="card">
          <h2 style={{ marginBottom: 4 }}>Wallet History</h2>
          <code
            style={{
              fontSize: 12,
              color: "var(--muted)",
              wordBreak: "break-all",
            }}
          >
            {address}
          </code>
        </div>

        <div className="card">
          <p style={{ color: "#ef4444" }}>Invalid wallet address format</p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
          <div>
            <h2 style={{ marginBottom: 4 }}>Wallet History</h2>
            <code
              style={{
                fontSize: 12,
                color: "var(--muted)",
                wordBreak: "break-all",
              }}
            >
              {address}
            </code>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {copied && <span style={{ fontSize: 12, color: "var(--green, #22c55e)" }}>Link copied!</span>}
            <button
              onClick={copyLink}
              title="Copy a shareable link with the current filters"
              style={{
                padding: "8px 16px",
                background: "var(--accent)",
                color: "#fff",
                border: "none",
                borderRadius: 4,
                cursor: "pointer",
                fontSize: 13,
              }}
            >
              🔗 Share
            </button>
          </div>
        </div>
      </div>

      {/* Filters row */}
      <div className="card" style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <label style={{ color: "var(--muted)" }}>From ledger:</label>
          <input
            type="number"
            value={fromLedger}
            onChange={(e) => updateParam("from", e.target.value)}
            placeholder="min"
            style={{ width: 100 }}
          />
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <label style={{ color: "var(--muted)" }}>To ledger:</label>
          <input
            type="number"
            value={toLedger}
            onChange={(e) => updateParam("to", e.target.value)}
            placeholder="max"
            style={{ width: 100 }}
          />
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <label style={{ color: "var(--muted)" }}>Function:</label>
          <select value={fnFilter} onChange={(e) => updateParam("fn", e.target.value)}>
            <option value="">All</option>
            {availableFunctions.map((fn) => (
              <option key={fn} value={fn}>
                {fn}
              </option>
            ))}
          </select>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <label style={{ color: "var(--muted)" }}>Group by:</label>
          <select value={groupBy} onChange={(e) => updateParam("group", e.target.value === "function" ? "function" : "")}>
            <option value="none">None</option>
            <option value="function">Function</option>
          </select>
        </div>
      </div>

      {xlmBalance && (
        <div className="card">
          <h3 style={{ marginBottom: 4 }}>XLM Balance</h3>
          <p style={{ fontSize: 18, fontWeight: 600 }}>{xlmBalance.balance} XLM</p>
        </div>
      )}

      <div className="card">
        {isLoading ? (
          <p style={{ color: "var(--muted)" }}>Loading…</p>
        ) : events.length === 0 ? (
          <p style={{ color: "var(--muted)" }}>No Soroban interactions found for this address</p>
        ) : filtered.length === 0 ? (
          <p style={{ color: "var(--muted)" }}>No events match the current filters</p>
        ) : groups ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            {groups.map(([fn, fnEvents]) => (
              <div key={fn}>
                <h3 style={{ fontSize: 14, marginBottom: 8 }}>
                  {fn} <span style={{ color: "var(--muted)", fontWeight: 400 }}>({fnEvents.length})</span>
                </h3>
                <EventTable events={fnEvents} />
              </div>
            ))}
          </div>
        ) : (
          <EventTable events={filtered} />
        )}
      </div>
    </div>
  );
}
