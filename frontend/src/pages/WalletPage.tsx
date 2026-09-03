import { useMemo, useState } from "react";
import { useParams, useSearchParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import type { ContractMeta, DecodedEvent } from "../api";
import EventTable from "../components/EventTable";
import ExportButton from "../components/ExportButton";
import WalletBalances from "../components/WalletBalances";
import ProtocolBadge from "../components/ProtocolBadge";
import {
  isMuxedAddress,
  muxedId,
  resolveMuxed,
  truncateAddress,
  isValidStellarAddress,
} from "../utils/strkey";

type GroupBy = "contract" | "none";

const EVENT_TYPE_CHIPS: { key: string; label: string }[] = [
  { key: "transfer", label: "Transfer" },
  { key: "swap", label: "Swap" },
  { key: "mint", label: "Mint" },
  { key: "burn", label: "Burn" },
  { key: "stake", label: "Stake" },
  { key: "other", label: "Other" },
];

const KNOWN_EVENT_TYPES = new Set(EVENT_TYPE_CHIPS.map((c) => c.key).filter((k) => k !== "other"));

// Events whose function doesn't match a known chip key fall into "other".
function eventTypeOf(fn: string): string {
  return KNOWN_EVENT_TYPES.has(fn) ? fn : "other";
}

function Chip({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: active ? "var(--accent)" : "var(--surface)",
        color: active ? "#0d1117" : "var(--muted)",
        border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
        borderRadius: 999,
        padding: "4px 12px",
        fontSize: 13,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

// Contract group section — collapsible, collapsed by default when > 3 contracts
function ContractSection({
  contractId,
  contractMeta,
  events,
  defaultOpen,
}: {
  contractId: string;
  contractMeta: ContractMeta | null | undefined;
  events: DecodedEvent[];
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const name = contractMeta?.name ?? null;
  const protocolType = contractMeta?.protocol_type ?? null;

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 8,
        overflow: "hidden",
      }}
    >
      {/* Section header */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 16px",
          background: "var(--surface)",
          border: "none",
          borderBottom: open ? "1px solid var(--border)" : "none",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span style={{ color: "var(--muted)", fontSize: 12, minWidth: 14 }}>
          {open ? "▾" : "▸"}
        </span>
        <span style={{ fontWeight: 600, fontSize: 14 }}>
          {name ?? truncateAddress(contractId)}
        </span>
        {!name && (
          <code
            style={{ fontSize: 11, color: "var(--muted)" }}
            title={contractId}
          >
            {truncateAddress(contractId)}
          </code>
        )}
        {protocolType && <ProtocolBadge type={protocolType} />}
        <span
          style={{
            marginLeft: "auto",
            fontSize: 12,
            color: "var(--muted)",
            fontWeight: 400,
          }}
        >
          {events.length} event{events.length !== 1 ? "s" : ""}
        </span>
      </button>
      {open && (
        <div style={{ padding: "12px 0" }}>
          <EventTable events={events} />
        </div>
      )}
    </div>
  );
}

// ── Summary bar ──────────────────────────────────────────────────────────────

function WalletSummary({ events }: { events: DecodedEvent[] }) {
  const uniqueContracts = useMemo(
    () => new Set(events.map((e) => e.contract_id).filter(Boolean)).size,
    [events],
  );
  const ledgers = events.map((e) => e.ledger).filter(Boolean);
  const firstLedger = ledgers.length ? Math.min(...ledgers) : null;
  const lastLedger = ledgers.length ? Math.max(...ledgers) : null;

  return (
    <div
      style={{
        display: "flex",
        gap: 32,
        flexWrap: "wrap",
        fontSize: 13,
        color: "var(--muted)",
      }}
    >
      <span>
        <strong style={{ color: "var(--fg, #e6edf3)" }}>{events.length}</strong>{" "}
        total event{events.length !== 1 ? "s" : ""}
      </span>
      <span>
        <strong style={{ color: "var(--fg, #e6edf3)" }}>{uniqueContracts}</strong>{" "}
        unique contract{uniqueContracts !== 1 ? "s" : ""}
      </span>
      {firstLedger != null && (
        <span>
          First: ledger{" "}
          <strong style={{ color: "var(--fg, #e6edf3)" }}>
            {firstLedger.toLocaleString()}
          </strong>
        </span>
      )}
      {lastLedger != null && (
        <span>
          Last: ledger{" "}
          <strong style={{ color: "var(--fg, #e6edf3)" }}>
            {lastLedger.toLocaleString()}
          </strong>
        </span>
      )}
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────

export default function WalletPage() {
  const { address = "" } = useParams<{ address: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [copied, setCopied] = useState(false);

  // ── Resolve muxed addresses ──────────────────────────────────────────────
  // M... muxed addresses resolve to a base G... account for querying.
  const resolvedAddress = isMuxedAddress(address) ? (resolveMuxed(address) ?? address) : address;
  const muxId = isMuxedAddress(address) ? muxedId(address) : null;

  // ── Validate address ─────────────────────────────────────────────────────
  const isValidAddress = isValidStellarAddress(address);

  // ── Filter state lives in the URL (permalink support, #527) ─────────────
  const fromDate = searchParams.get("from") ?? "";
  const toDate = searchParams.get("to") ?? "";
  const fnFilter = searchParams.get("fn") ?? "";
  const groupBy = (
    searchParams.get("group") === "contract" ? "contract" : "none"
  ) as GroupBy;

  // ── Update document title (#525) ─────────────────────────────────────────
  if (address) {
    document.title = `Wallet ${truncateAddress(address)} — Soroban Explorer`;
  }

  // ── Event-type filter (chips), persisted in the URL like the other filters ──
  const typesParam = searchParams.get("types") ?? "";
  const selectedTypes = useMemo(
    () => new Set(typesParam ? typesParam.split(",").filter(Boolean) : []),
    [typesParam],
  );

  const walletQuery = useQuery({
    queryKey: ["walletHistory", address, fromDate, toDate],
    queryFn: () => api.walletHistory(address, { from: fromDate, to: toDate }),
    enabled: !!address && isValidAddress,
  });
  const allEvents = walletQuery.data?.events ?? [];
  const horizonAccount = walletQuery.data?.horizon_account ?? null;
  const xlmBalance = horizonAccount?.balances?.find((b) => b.asset_type === "native");

  // ── Client-side function-name + event-type filters (server only filters by date) ──
  const filtered = useMemo(() => {
    let result = fnFilter ? allEvents.filter((ev) => ev.function === fnFilter) : allEvents;
    if (selectedTypes.size > 0) {
      result = result.filter((ev) => selectedTypes.has(eventTypeOf(ev.function)));
    }
    return result;
  }, [allEvents, fnFilter, selectedTypes]);

  const availableFunctions = useMemo(
    () => Array.from(new Set(allEvents.map((ev) => ev.function))).sort(),
    [allEvents],
  );

  // ── Fetch contract metadata for all unique contracts (#526) ──────────────
  const contractIds = useMemo(
    () => Array.from(new Set(filtered.map((e) => e.contract_id).filter(Boolean))),
    [filtered],
  );

  // We use individual queries per contract so TanStack Query can cache each one.
  // Limit to 20 contracts to avoid request flooding.
  const contractQueries = useQuery({
    queryKey: ["contractsMeta", contractIds.slice(0, 20)],
    queryFn: async () => {
      const results = await Promise.allSettled(
        contractIds.slice(0, 20).map((id) => api.contract(id)),
      );
      return Object.fromEntries(
        contractIds.slice(0, 20).map((id, i) => {
          const r = results[i];
          return [id, r.status === "fulfilled" ? r.value : null];
        }),
      ) as Record<string, ContractMeta | null>;
    },
    enabled: contractIds.length > 0 && groupBy === "contract",
    staleTime: 60_000,
  });

  const contractMetas: Record<string, ContractMeta | null> = contractQueries.data ?? {};

  // ── Group by contract (#526) ──────────────────────────────────────────────
  const contractGroups = useMemo((): [string, DecodedEvent[]][] | null => {
    if (groupBy !== "contract") return null;
    const byContract = new Map<string, DecodedEvent[]>();
    for (const ev of filtered) {
      const key = ev.contract_id || "__unknown__";
      if (!byContract.has(key)) byContract.set(key, []);
      byContract.get(key)!.push(ev);
    }
    // Sort by event count desc
    return [...byContract.entries()].sort(([, a], [, b]) => b.length - a.length);
  }, [filtered, groupBy]);

  const totalContracts = contractGroups?.length ?? 0;

  // ── URL param helper ──────────────────────────────────────────────────────
  function updateParam(key: string, value: string) {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { replace: true });
  }

  function toggleType(key: string) {
    const next = new Set(selectedTypes);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    updateParam("types", Array.from(next).join(","));
  }

  // ── Share / copy link ─────────────────────────────────────────────────────
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable — silently ignore */
    }
  }

  if (address && !isValidAddress) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <div className="card">
          <h2 style={{ marginBottom: 4 }}>Wallet History</h2>
          <code style={{ fontSize: 12, color: "var(--muted)", wordBreak: "break-all" }}>
            {address}
          </code>
        </div>
        <div className="card">
          <p style={{ color: "#ef4444" }}>
            <strong>{address}</strong> is not a valid Stellar address.
            Valid addresses start with G (account), M (muxed), or C (contract).
          </p>
        </div>
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Header card */}
      <div className="card">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div>
            <h2 style={{ marginBottom: 4 }}>Wallet History</h2>
            <code
              style={{ fontSize: 12, color: "var(--muted)", wordBreak: "break-all" }}
              title={address}
            >
              {address}
            </code>
            {muxId && (
              <p style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>
                Muxed ID: {muxId} → base account{" "}
                <Link to={`/wallet/${resolvedAddress}`}>
                  {truncateAddress(resolvedAddress)}
                </Link>
              </p>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {copied && (
              <span style={{ fontSize: 12, color: "var(--green, #22c55e)" }}>
                Link copied!
              </span>
            )}
            <button
              onClick={copyLink}
              title="Copy a shareable link with the current filters"
              style={{
                padding: "8px 16px",
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 4,
                cursor: "pointer",
                fontSize: 13,
                color: "var(--muted)",
              }}
            >
              🔗 Share
            </button>
            {/* Export dropdown (CSV / NDJSON) */}
            <ExportButton
              target="events"
              params={{
                wallet: address || undefined,
                fn: fnFilter || undefined,
              }}
            />
          </div>
        </div>

        {/* Summary row (#525) */}
        {allEvents.length > 0 && (
          <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--border)" }}>
            <WalletSummary events={allEvents} />
          </div>
        )}
      </div>

      {/* Filters row (#527 date range + existing filters) */}
      <div
        className="card"
        style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}
      >
        {/* Date range (#527) */}
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <label style={{ color: "var(--muted)", fontSize: 13 }}>From:</label>
          <input
            type="date"
            value={fromDate}
            onChange={(e) => updateParam("from", e.target.value)}
            style={{ fontSize: 13 }}
            title="Filter events from this date"
          />
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <label style={{ color: "var(--muted)", fontSize: 13 }}>To:</label>
          <input
            type="date"
            value={toDate}
            onChange={(e) => updateParam("to", e.target.value)}
            style={{ fontSize: 13 }}
            title="Filter events up to this date"
          />
        </div>

        {/* Function filter */}
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <label style={{ color: "var(--muted)", fontSize: 13 }}>Function:</label>
          <select
            value={fnFilter}
            onChange={(e) => updateParam("fn", e.target.value)}
            style={{ fontSize: 13 }}
          >
            <option value="">All</option>
            {availableFunctions.map((fn) => (
              <option key={fn} value={fn}>
                {fn}
              </option>
            ))}
          </select>
        </div>

        {/* Group by (#526) */}
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <label style={{ color: "var(--muted)", fontSize: 13 }}>Group by:</label>
          <select
            value={groupBy}
            onChange={(e) =>
              updateParam("group", e.target.value === "contract" ? "contract" : "")
            }
            style={{ fontSize: 13 }}
          >
            <option value="none">Flat list</option>
            <option value="contract">Contract</option>
          </select>
        </div>

        {/* Event type filter */}
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <label style={{ color: "var(--muted)", fontSize: 13 }}>Type:</label>
          {EVENT_TYPE_CHIPS.map((chip) => (
            <Chip
              key={chip.key}
              label={chip.label}
              active={selectedTypes.has(chip.key)}
              onClick={() => toggleType(chip.key)}
            />
          ))}
        </div>

        {/* Clear filters */}
        {(fromDate || toDate || fnFilter || groupBy !== "none" || selectedTypes.size > 0) && (
          <button
            type="button"
            onClick={() => setSearchParams({}, { replace: true })}
            style={{
              padding: "4px 12px",
              background: "transparent",
              border: "1px solid var(--border)",
              borderRadius: 4,
              cursor: "pointer",
              fontSize: 12,
              color: "var(--muted)",
            }}
          >
            ✕ Clear filters
          </button>
        )}
      </div>

      {/* XLM balance */}
      {xlmBalance && (
        <div className="card">
          <h3 style={{ marginBottom: 4 }}>XLM Balance</h3>
          <p style={{ fontSize: 18, fontWeight: 600 }}>{xlmBalance.balance} XLM</p>
        </div>
      )}

      {/* Wallet token balances */}
      <div className="card">
        <WalletBalances address={address} />
      </div>

      {/* Events section */}
      <div className="card">
        {walletQuery.isLoading ? (
          <p style={{ color: "var(--muted)" }}>Loading…</p>
        ) : allEvents.length === 0 ? (
          /* Empty state (#525) */
          <div style={{ textAlign: "center", padding: "32px 16px" }}>
            <p style={{ color: "var(--muted)", marginBottom: 12 }}>
              No Soroban interactions found for this address.
            </p>
            <Link
              to="/contracts/register"
              style={{ color: "var(--accent)", fontSize: 14 }}
            >
              Register a contract to start seeing decoded events →
            </Link>
          </div>
        ) : filtered.length === 0 ? (
          <p style={{ color: "var(--muted)" }}>No events match the current filters.</p>
        ) : groupBy === "contract" && contractGroups ? (
          /* Grouped by contract (#526) */
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {contractGroups.map((entry: [string, DecodedEvent[]], idx: number) => {
              const [contractId, contractEvents] = entry;
              return (
                <ContractSection
                  key={contractId}
                  contractId={contractId}
                  contractMeta={contractMetas[contractId] ?? null}
                  events={contractEvents}
                  defaultOpen={totalContracts <= 3 || idx === 0}
                />
              );
            })}
          </div>
        ) : (
          /* Flat list (#525) */
          <EventTable events={filtered} />
        )}
      </div>
    </div>
  );
}
