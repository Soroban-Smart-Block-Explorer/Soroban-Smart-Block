import { FormEvent, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  api,
  type DecodedEvent,
  type SearchContract,
  type SearchKind,
  type SearchResponse,
  type SearchWallet,
} from "../api";
import { truncateAddress } from "../utils/strkey";
import EventTable from "../components/EventTable";

type FilterKind = SearchKind | "all";

const KINDS: { key: FilterKind; label: string }[] = [
  { key: "all", label: "All" },
  { key: "contract", label: "Contracts" },
  { key: "event", label: "Events" },
  { key: "wallet", label: "Wallets" },
];

const EXAMPLES = [
  { label: "USDC", query: "USDC" },
  { label: "swap", query: "swap" },
  { label: "GABC...", query: "GABC" },
  { label: "contract ID", query: "0x" },
];

export default function SearchPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const [q, setQ] = useState(searchParams.get("q") ?? "");
  const kind = (searchParams.get("kind") ?? "all") as FilterKind;

  const { data, error, isLoading } = useQuery({
    queryKey: ["search", q, kind],
    queryFn: () => api.search(q, 50),
    enabled: q.trim().length > 0,
  });

  const filtered = useMemo(() => filterResults(data, kind), [data, kind]);

  function submit(e: FormEvent) {
    e.preventDefault();
    const value = q.trim();
    if (!value) return;

    const next = new URLSearchParams();
    next.set("q", value);
    if (kind !== "all") next.set("kind", kind);
    navigate(`/search?${next}`);
  }

  function updateKind(next: FilterKind) {
    const params = new URLSearchParams(searchParams);
    params.set("q", q.trim() || searchParams.get("q") || "");
    if (next === "all") params.delete("kind");
    else params.set("kind", next);
    setSearchParams(params);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div>
        <h1 style={{ fontSize: 22, marginBottom: 6 }}>Search</h1>
        <p style={{ color: "var(--muted)" }}>Search contracts, events, and wallets in one place.</p>
      </div>

      <form onSubmit={submit} className="card" style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by contract, event, wallet, token, tx hash, or description…"
          style={{ flex: 1 }}
          autoFocus
        />
        <button type="submit">Search</button>
      </form>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {KINDS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => updateKind(item.key)}
            style={{
              background: kind === item.key ? "var(--accent)" : "var(--surface)",
              color: kind === item.key ? "#0d1117" : "var(--muted)",
              border: `1px solid ${kind === item.key ? "var(--accent)" : "var(--border)"}`,
            }}
          >
            {item.label}
          </button>
        ))}
      </div>

      {q.trim() && <ExampleQueries />}

      {error && <p style={{ color: "#f85149" }}>{String((error as Error).message)}</p>}
      {isLoading && <p style={{ color: "var(--muted)" }}>Searching…</p>}

      {data && !isLoading && <SearchSummary data={data} kind={kind} />}

      {data && !isLoading && data.suggestions.length > 0 && <Suggestions suggestions={data.suggestions} />}

      {data && !isLoading && <Results data={filtered} query={data.query} />}
    </div>
  );
}

function ExampleQueries() {
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {EXAMPLES.map((item) => (
        <Link
          key={item.query}
          to={`/search?q=${encodeURIComponent(item.query)}`}
          className="badge"
          style={{ color: "var(--muted)" }}
        >
          {item.label}
        </Link>
      ))}
    </div>
  );
}

function SearchSummary({ data, kind }: { data: SearchResponse; kind: FilterKind }) {
  const label = kind === "all" ? "all results" : `${kind} results`;
  const count =
    kind === "contract"
      ? data.contracts.length
      : kind === "event"
        ? data.events.length
        : kind === "wallet"
          ? data.wallets.length
          : data.contracts.length + data.events.length + data.wallets.length;

  return (
    <div className="card" style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
      <div>
        <strong>{count}</strong> {label} for <code>{data.query}</code>
      </div>
      <div style={{ color: "var(--muted)" }}>
        Contracts {data.contracts.length} · Events {data.events.length} · Wallets {data.wallets.length}
      </div>
    </div>
  );
}

function Suggestions({ suggestions }: { suggestions: SearchResponse["suggestions"] }) {
  return (
    <div className="card">
      <h2 style={{ fontSize: 14, marginBottom: 10 }}>Suggestions</h2>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {suggestions.map((s) => (
          <Link key={`${s.kind}:${s.label}`} to={s.route} className="badge" style={{ color: "var(--text)" }}>
            {s.label}
          </Link>
        ))}
      </div>
    </div>
  );
}

function Results({ data, query }: { data: FilteredSearchResults; query: string }) {
  if (!data.contracts.length && !data.events.length && !data.wallets.length) {
    return (
      <div className="card">
        No results for <code>{query}</code>. Try a token symbol, event function, address, transaction hash, or description text.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {data.contracts.length > 0 && <ContractResults contracts={data.contracts} />}
      {data.events.length > 0 && <EventResults events={data.events} />}
      {data.wallets.length > 0 && <WalletResults wallets={data.wallets} />}
    </div>
  );
}

function ContractResults({ contracts }: { contracts: SearchContract[] }) {
  return (
    <div className="card">
      <h2 style={{ fontSize: 14, marginBottom: 12 }}>Contracts</h2>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {contracts.map((contract) => (
          <article key={contract.id} style={{ borderBottom: "1px solid var(--border)", paddingBottom: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
              <div>
                <Link to={`/contract/${contract.id}`} style={{ fontWeight: 700 }}>
                  {contract.name || contract.id}
                </Link>
                {contract.description && <p style={{ color: "var(--muted)", marginTop: 4 }}>{contract.description}</p>}
              </div>
              <span className="badge">{contract.event_count} events</span>
            </div>
            <code
              style={{ display: "block", marginTop: 8, color: "var(--muted)", fontSize: 12, wordBreak: "break-all" }}
            >
              {contract.id}
            </code>
            {(() => {
              const functions = contract.functions ?? [];
              if (!functions.length) return null;
              return (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                  {functions.slice(0, 8).map((fn) => (
                    <span key={fn.name} className="badge green">
                      {fn.name}
                    </span>
                  ))}
                </div>
              );
            })()}
          </article>
        ))}
      </div>
    </div>
  );
}

function EventResults({ events }: { events: DecodedEvent[] }) {
  return (
    <div className="card">
      <h2 style={{ fontSize: 14, marginBottom: 12 }}>Events</h2>
      <EventTable events={events} />
    </div>
  );
}

function WalletResults({ wallets }: { wallets: SearchWallet[] }) {
  return (
    <div className="card">
      <h2 style={{ fontSize: 14, marginBottom: 12 }}>Wallets</h2>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {wallets.map((wallet) => (
          <article key={wallet.address} style={{ borderBottom: "1px solid var(--border)", paddingBottom: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
              <Link to={`/wallet/${wallet.address}`} style={{ fontFamily: "monospace", wordBreak: "break-all" }}>
                {truncateAddress(wallet.address)}
              </Link>
              <span className="badge">{wallet.event_count} events</span>
            </div>
            <div style={{ color: "var(--muted)", marginTop: 6 }}>
              Last ledger {wallet.last_seen_ledger?.toLocaleString() ?? "unknown"}
              {wallet.contracts.length > 0 && (
                <span>
                  {" "}
                  · Contracts{" "}
                  {wallet.contracts.slice(0, 3).map((id, index) => (
                    <span key={id}>
                      {index > 0 ? ", " : ""}
                      <Link to={`/contract/${id}`}>{truncateAddress(id)}</Link>
                    </span>
                  ))}
                  {wallet.contracts.length > 3 && <> +{wallet.contracts.length - 3}</>}
                </span>
              )}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

interface FilteredSearchResults {
  contracts: SearchContract[];
  events: DecodedEvent[];
  wallets: SearchWallet[];
}

function filterResults(data: SearchResponse | undefined, kind: FilterKind): FilteredSearchResults {
  if (!data) return { contracts: [], events: [], wallets: [] };
  if (kind === "contract") return { contracts: data.contracts, events: [], wallets: [] };
  if (kind === "event") return { contracts: [], events: data.events, wallets: [] };
  if (kind === "wallet") return { contracts: [], events: [], wallets: data.wallets };
  return { contracts: data.contracts, events: data.events, wallets: data.wallets };
}
