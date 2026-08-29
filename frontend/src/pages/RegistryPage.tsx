/**
 * RegistryPage — Issues #513 / #514
 *
 * Contract registry list page with:
 * - Search input (300 ms debounce, reflected in URL as ?q=)
 * - Filter dropdown: All / Verified / DEX / Lending / NFT (?type=)
 * - Skeleton loader while fetching
 * - Empty state with link to register form
 * - Pagination (page-based, Load more style kept for compat)
 */
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { api, type ContractListItem, type ContractsListResponse, type ContractStats } from "../api";
import { truncateAddress } from "../utils/strkey";
import ProtocolBadge from "../components/ProtocolBadge";
import { useVirtualList, ROW_HEIGHT } from "../hooks/useVirtualList";

// Max concurrent /stats requests when batch-fetching activity for the visible page (#609).
const MAX_CONCURRENT_STATS_FETCHES = 10;

function timeAgo(dateStr: string): string {
  const diffDays = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86_400_000);
  if (diffDays <= 0) return "today";
  if (diffDays === 1) return "1 day ago";
  return `${diffDays} days ago`;
}

/** 7-day daily event-count sparkline — plain SVG, no chart library. */
function MiniSparkline({ data }: { data: { date: string; count: number }[] }) {
  const w = 80;
  const h = 20;
  const maxCount = Math.max(...data.map((d) => d.count), 1);
  const pts = data
    .map((d, i) => {
      const x = (i / (data.length - 1 || 1)) * w;
      const y = h - (d.count / maxCount) * h;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-label="Events over the last 7 days" style={{ display: "block", flexShrink: 0 }}>
      <polyline points={pts} fill="none" stroke="var(--accent)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

const PROTOCOL_TYPES = [
  { value: "all", label: "All types" },
  { value: "verified", label: "Verified" },
  { value: "dex", label: "DEX" },
  { value: "lending", label: "Lending" },
  { value: "nft", label: "NFT" },
] as const;

function SkeletonRow() {
  return (
    <tr style={{ borderBottom: "1px solid var(--border)" }}>
      {[180, 300, 140, 100, 90].map((w, i) => (
        <td key={i} style={{ padding: "12px 4px" }}>
          <span
            style={{
              display: "inline-block",
              width: w,
              height: 14,
              background: "var(--border)",
              borderRadius: 3,
              opacity: 0.6,
            }}
            aria-hidden="true"
          />
        </td>
      ))}
    </tr>
  );
}

export default function RegistryPage() {
  const [searchParams, setSearchParams] = useSearchParams();

  // Initialise state from URL so links are shareable
  const [inputValue, setInputValue] = useState(() => searchParams.get("q") ?? "");
  const [filterType, setFilterType] = useState(() => searchParams.get("type") ?? "all");
  const [page, setPage] = useState(1);

  // Committed query — updated after debounce
  const [query, setQuery] = useState(() => searchParams.get("q") ?? "");

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const limit = 25;

  // Debounce the search input (300 ms)
  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      setQuery(inputValue);
      setPage(1);
    }, 300);
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [inputValue]);

  // Keep URL in sync so links are shareable
  useEffect(() => {
    const next = new URLSearchParams();
    if (query) next.set("q", query);
    if (filterType && filterType !== "all") next.set("type", filterType);
    setSearchParams(next, { replace: true });
  }, [query, filterType, setSearchParams]);

  const { data, isLoading, isError, error } = useQuery<ContractsListResponse>({
    queryKey: ["contracts", "search", query, filterType, page, limit],
    queryFn: () =>
      api.listContractsSearch({ q: query || undefined, type: filterType, page, limit }),
    placeholderData: keepPreviousData,
  });

  const contracts = data?.contracts ?? [];
  const pagination = data?.pagination;

  // Virtualize the row list so large pages (or a future higher page size)
  // stay smooth on scroll (#751).
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const { totalHeight, visibleItems } = useVirtualList(contracts, scrollContainerRef);

  // Batch-fetch event-count / last-activity stats for the visible contracts,
  // capped at MAX_CONCURRENT_STATS_FETCHES concurrent requests (#609).
  const [statsById, setStatsById] = useState<Record<string, ContractStats>>({});

  useEffect(() => {
    const ids = contracts.map((c) => c.id).filter((id) => !(id in statsById));
    if (ids.length === 0) return;

    let cancelled = false;

    (async () => {
      for (let i = 0; i < ids.length; i += MAX_CONCURRENT_STATS_FETCHES) {
        const batch = ids.slice(i, i + MAX_CONCURRENT_STATS_FETCHES);
        const results = await Promise.all(batch.map((id) => api.contractStats(id).catch(() => null)));
        if (cancelled) return;
        setStatsById((prev) => {
          const next = { ...prev };
          batch.forEach((id, idx) => {
            const stats = results[idx];
            if (stats && typeof stats.total_events === "number" && Array.isArray(stats.events_per_day)) {
              next[id] = stats;
            }
          });
          return next;
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [contracts]);

  function handleFilterChange(e: React.ChangeEvent<HTMLSelectElement>) {
    setFilterType(e.target.value);
    setPage(1);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
        <div>
          <h1 style={{ fontSize: 22, marginBottom: 4 }}>Contract Registry</h1>
          <p style={{ color: "var(--muted)" }}>
            Registered Soroban smart contracts on the Stellar network.
          </p>
        </div>
        <Link
          to="/contracts/register"
          style={{
            padding: "7px 16px",
            fontWeight: 600,
            fontSize: 13,
            whiteSpace: "nowrap",
            background: "var(--accent, #238636)",
            color: "#fff",
            borderRadius: 6,
            textDecoration: "none",
          }}
        >
          + Register contract
        </Link>
      </div>

      {/* Search + filter bar */}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          type="search"
          aria-label="Search contracts"
          placeholder="Search by name or description…"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          style={{ flex: 1, maxWidth: 420 }}
        />
        <select
          aria-label="Filter by protocol type"
          value={filterType}
          onChange={handleFilterChange}
          style={{ minWidth: 140 }}
        >
          {PROTOCOL_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </div>

      {/* Table */}
      <div className="card">
        {isError && (
          <p role="alert" style={{ color: "#f85149" }}>
            {(error as Error).message}
          </p>
        )}

        <table style={{ width: "100%", borderCollapse: "collapse" }} aria-label="Contracts list">
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border)", textAlign: "left" }}>
              <th style={{ padding: "8px 4px" }}>Name</th>
              <th style={{ padding: "8px 4px" }}>Contract ID</th>
              <th style={{ padding: "8px 4px" }}>Registered By</th>
              <th style={{ padding: "8px 4px" }}>Created At</th>
              <th style={{ padding: "8px 4px" }}>Activity</th>
            </tr>
          </thead>
          {isLoading && (
            <tbody>
              {Array.from({ length: 5 }).map((_, i) => <SkeletonRow key={i} />)}
            </tbody>
          )}
        </table>

        {!isLoading && contracts.length > 0 && (
          <div
            ref={scrollContainerRef}
            data-testid="virtual-scroll-container"
            style={{ overflowY: "auto", maxHeight: contracts.length > 10 ? 600 : undefined, position: "relative" }}
          >
            <div style={{ height: totalHeight, position: "relative" }}>
              {visibleItems.map(({ item: c, style }: { item: ContractListItem; style: React.CSSProperties }) => (
                <div key={c.id} style={{ ...style, height: ROW_HEIGHT }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
                    <tbody>
                      <tr style={{ borderBottom: "1px solid var(--border)" }}>
                        <td style={{ padding: "10px 4px" }}>
                          <Link to={`/contract/${c.id}`} style={{ fontWeight: 600 }}>
                            {c.name || truncateAddress(c.id)}
                          </Link>{" "}
                          <ProtocolBadge type={c.protocol_type} />
                          {c.description && (
                            <p style={{ color: "var(--muted)", marginTop: 2, fontSize: 12 }}>
                              {c.description}
                            </p>
                          )}
                        </td>
                        <td style={{ padding: "10px 4px" }}>
                          <code style={{ fontSize: 12, color: "var(--muted)", wordBreak: "break-all" }}>
                            {c.id}
                          </code>
                        </td>
                        <td style={{ padding: "10px 4px" }}>
                          <code style={{ fontSize: 12 }}>{truncateAddress(c.registered_by)}</code>
                        </td>
                        <td style={{ padding: "10px 4px", color: "var(--muted)", fontSize: 12 }}>
                          {new Date(c.created_at).toLocaleString()}
                        </td>
                        <td style={{ padding: "10px 4px" }}>
                          {statsById[c.id] ? (
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              <div>
                                <div style={{ fontSize: 12 }}>
                                  {statsById[c.id].total_events.toLocaleString()} events
                                </div>
                                <div style={{ fontSize: 11, color: "var(--muted)" }}>
                                  {(() => {
                                    const lastActive = [...statsById[c.id].events_per_day]
                                      .reverse()
                                      .find((d) => d.count > 0);
                                    return lastActive ? `Last active ${timeAgo(lastActive.date)}` : "No activity";
                                  })()}
                                </div>
                              </div>
                              <MiniSparkline data={statsById[c.id].events_per_day.slice(-7)} />
                            </div>
                          ) : (
                            <span style={{ fontSize: 11, color: "var(--muted)" }}>—</span>
                          )}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Empty state */}
        {!isLoading && !isError && contracts.length === 0 && (
          <div
            style={{
              padding: "32px 16px",
              textAlign: "center",
              color: "var(--muted)",
            }}
          >
            <p style={{ fontSize: 16, marginBottom: 12 }}>
              {query || filterType !== "all"
                ? "No contracts match your search."
                : "No contracts registered yet."}
            </p>
            <p>
              <Link to="/contracts/register" style={{ fontWeight: 600 }}>
                Be the first to register one →
              </Link>
            </p>
          </div>
        )}
      </div>

      {/* Pagination */}
      {pagination && pagination.total_pages > 1 && (
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            ← Prev
          </button>
          <span style={{ color: "var(--muted)" }}>
            Page {page} of {pagination.total_pages} ({pagination.total} total)
          </span>
          <button
            disabled={page >= pagination.total_pages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
