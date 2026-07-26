import { useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { api } from "../api";
import type { NftToken } from "../api";
import NftCard from "../components/NftCard";
import NftDetailModal from "../components/NftDetailModal";

const PAGE_SIZE = 50;

export default function NftGallery() {
  const { contractId = "" } = useParams<{ contractId: string }>();

  const [page, setPage] = useState(1);
  const [ownerFilter, setOwnerFilter] = useState("");
  const [ownerInput, setOwnerInput] = useState("");
  const [selectedToken, setSelectedToken] = useState<NftToken | null>(null);

  const { data, isLoading, error, isFetching } = useQuery({
    queryKey: ["nfts", contractId, page, ownerFilter],
    queryFn: () =>
      api.nfts(contractId, {
        page,
        limit: PAGE_SIZE,
        owner: ownerFilter || undefined,
      }),
    enabled: !!contractId,
    placeholderData: keepPreviousData,
  });

  function applyOwnerFilter() {
    setOwnerFilter(ownerInput.trim());
    setPage(1);
  }

  function clearOwnerFilter() {
    setOwnerInput("");
    setOwnerFilter("");
    setPage(1);
  }

  const tokens = data?.tokens ?? [];
  const pagination = data?.pagination;
  const totalPages = pagination?.total_pages ?? 1;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Page header */}
      <div className="card">
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <h1 style={{ fontSize: 20, marginBottom: 4 }}>NFT Collection</h1>
            <code style={{ fontSize: 12, color: "var(--muted)", wordBreak: "break-all" }}>
              {contractId}
            </code>
          </div>
          {pagination && (
            <span className="badge" style={{ alignSelf: "flex-start", marginTop: 4 }}>
              {pagination.total.toLocaleString()} tokens
            </span>
          )}
        </div>
      </div>

      {/* Owner filter */}
      <div className="card" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <label
          htmlFor="owner-filter"
          style={{ fontSize: 13, color: "var(--muted)", whiteSpace: "nowrap" }}
        >
          Filter by owner:
        </label>
        <input
          id="owner-filter"
          type="text"
          placeholder="Stellar address (G…)"
          value={ownerInput}
          onChange={(e) => setOwnerInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && applyOwnerFilter()}
          style={{ flex: 1, minWidth: 180 }}
          aria-label="Filter by owner address"
        />
        <button onClick={applyOwnerFilter} aria-label="Apply owner filter">
          Filter
        </button>
        {ownerFilter && (
          <button
            onClick={clearOwnerFilter}
            aria-label="Clear owner filter"
            style={{ background: "var(--border)", color: "var(--text)" }}
          >
            Clear
          </button>
        )}
      </div>

      {/* Active filter indicator */}
      {ownerFilter && (
        <p style={{ fontSize: 12, color: "var(--muted)" }}>
          Showing tokens owned by <code style={{ fontSize: 12 }}>{ownerFilter}</code>
        </p>
      )}

      {/* Loading / error / empty states */}
      {isLoading && (
        <div className="card">
          <p style={{ color: "var(--muted)" }}>Loading NFTs…</p>
        </div>
      )}

      {!isLoading && error && (
        <div className="card">
          <p style={{ color: "#f85149" }}>
            Failed to load NFTs: {(error as Error).message}
          </p>
        </div>
      )}

      {!isLoading && !error && tokens.length === 0 && (
        <div className="card" style={{ textAlign: "center", padding: 40 }}>
          <p style={{ color: "var(--muted)", marginBottom: 8 }}>
            {ownerFilter
              ? "No tokens found for this owner."
              : "No minted NFTs found for this collection yet."}
          </p>
          <p style={{ color: "var(--muted)", fontSize: 12 }}>
            NFT tokens appear here once they are indexed from on-chain mint events.
          </p>
        </div>
      )}

      {/* NFT grid */}
      {tokens.length > 0 && (
        <>
          <div
            role="list"
            aria-label={`NFT grid — ${tokens.length} tokens shown`}
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
              gap: 16,
              opacity: isFetching ? 0.6 : 1,
              transition: "opacity 150ms ease",
            }}
          >
            {tokens.map((token) => (
              <div key={token.token_id} role="listitem">
                <NftCard token={token} onClick={setSelectedToken} />
              </div>
            ))}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <nav
              aria-label="NFT pagination"
              style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "center", flexWrap: "wrap" }}
            >
              <button
                onClick={() => setPage(1)}
                disabled={page === 1}
                aria-label="First page"
                style={{
                  background: page === 1 ? "var(--border)" : "var(--accent)",
                  color: page === 1 ? "var(--muted)" : "#0d1117",
                  padding: "4px 10px",
                  fontSize: 12,
                }}
              >
                ««
              </button>
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                aria-label="Previous page"
                style={{
                  background: page === 1 ? "var(--border)" : "var(--accent)",
                  color: page === 1 ? "var(--muted)" : "#0d1117",
                  padding: "4px 10px",
                  fontSize: 12,
                }}
              >
                ‹ Prev
              </button>

              <span style={{ fontSize: 12, color: "var(--muted)", padding: "4px 4px" }}>
                Page {page} of {totalPages}
              </span>

              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                aria-label="Next page"
                style={{
                  background: page === totalPages ? "var(--border)" : "var(--accent)",
                  color: page === totalPages ? "var(--muted)" : "#0d1117",
                  padding: "4px 10px",
                  fontSize: 12,
                }}
              >
                Next ›
              </button>
              <button
                onClick={() => setPage(totalPages)}
                disabled={page === totalPages}
                aria-label="Last page"
                style={{
                  background: page === totalPages ? "var(--border)" : "var(--accent)",
                  color: page === totalPages ? "var(--muted)" : "#0d1117",
                  padding: "4px 10px",
                  fontSize: 12,
                }}
              >
                »»
              </button>
            </nav>
          )}
        </>
      )}

      {/* NFT detail modal */}
      {selectedToken && (
        <NftDetailModal
          contractId={contractId}
          token={selectedToken}
          onClose={() => setSelectedToken(null)}
        />
      )}
    </div>
  );
}
