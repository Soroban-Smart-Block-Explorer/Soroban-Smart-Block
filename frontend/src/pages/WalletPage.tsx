import { useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import EventTable from "../components/EventTable";
import WalletBalances from "../components/WalletBalances";
import { isMuxedAddress, muxedId, resolveMuxed } from "../utils/strkey";

const EVENT_TYPE_CHIPS: { key: string; label: string }[] = [
  { key: "transfer", label: "Transfer" },
  { key: "swap", label: "Swap" },
  { key: "mint", label: "Mint" },
  { key: "burn", label: "Burn" },
  { key: "stake", label: "Stake" },
  { key: "other", label: "Other" },
];

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
      }}
    >
      {label}
    </button>
  );
}

export default function WalletPage() {
  const { address = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();

  // Issue #531: M... muxed addresses resolve to their base G... account for
  // fetching events, while the page header keeps showing the muxed address.
  const muxed = isMuxedAddress(address);
  const baseAddress = muxed ? resolveMuxed(address) : null;
  const queryAddress = baseAddress ?? address;
  const id = muxed ? muxedId(address) : null;

  // Issue #532: multi-select event-type filter, synced to the ?fn= URL param.
  const selectedTypes = new Set(
    (searchParams.get("fn") ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );

  const { data: events = [], isLoading } = useQuery({
    queryKey: ["wallet", queryAddress, [...selectedTypes].sort().join(",")],
    queryFn: () => api.wallet(queryAddress, selectedTypes.size ? { fn: [...selectedTypes].join(",") } : undefined),
    enabled: !!queryAddress,
  });

  function toggleType(key: string) {
    const next = new Set(selectedTypes);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    const params = new URLSearchParams(searchParams);
    if (next.size) params.set("fn", [...next].join(","));
    else params.delete("fn");
    setSearchParams(params, { replace: true });
  }

  function clearTypes() {
    const params = new URLSearchParams(searchParams);
    params.delete("fn");
    setSearchParams(params, { replace: true });
  }

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
          title={
            muxed && baseAddress ? `Showing events for the base account ${baseAddress} (muxed ID: ${id})` : undefined
          }
        >
          {address}
        </code>
      </div>

      <div className="card">
        <WalletBalances address={queryAddress} />
      </div>

      <div className="card">
        <div style={{ marginBottom: 16, display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Chip active={selectedTypes.size === 0} label="All" onClick={clearTypes} />
          {EVENT_TYPE_CHIPS.map((c) => (
            <Chip key={c.key} active={selectedTypes.has(c.key)} label={c.label} onClick={() => toggleType(c.key)} />
          ))}
        </div>

        {isLoading ? (
          <p style={{ color: "var(--muted)" }}>Loading…</p>
        ) : events.length === 0 ? (
          <p style={{ color: "var(--muted)" }}>No Soroban interactions found for this address</p>
        ) : (
          <EventTable events={events} />
        )}
      </div>
    </div>
  );
}
