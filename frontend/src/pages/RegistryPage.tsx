import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { truncateAddress } from "../utils/strkey";

const PROTOCOL_TYPES = ["", "token", "dex", "lending", "nft", "bridge", "other"] as const;
type ProtocolTypeFilter = (typeof PROTOCOL_TYPES)[number];

const TYPE_LABELS: Record<string, string> = {
  "": "All Types",
  token: "Token",
  dex: "DEX",
  lending: "Lending",
  nft: "NFT",
  bridge: "Bridge",
  other: "Other",
};

/** Blue checkmark badge shown for contracts verified against the on-chain ABI registry. */
function VerifiedBadge({ ledger }: { ledger: number | null }) {
  return (
    <span
      title={ledger ? `ABI verified against on-chain registry at ledger #${ledger}` : "ABI verified against on-chain registry"}
      style={{
        display: "inline-flex",
        alignItems: "center",
        marginLeft: 6,
        cursor: "default",
        userSelect: "none",
      }}
      aria-label="Verified contract"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <circle cx="8" cy="8" r="8" fill="#1d9bf0" />
        <path
          d="M4.5 8l2.5 2.5 4.5-5"
          stroke="white"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

export default function RegistryPage() {
  const [page, setPage] = useState(1);
  const [typeFilter, setTypeFilter] = useState<ProtocolTypeFilter>("");
  const limit = 25;

  const { data, isLoading, error } = useQuery({
    queryKey: ["contracts", "list", page, limit, typeFilter],
    queryFn: () => api.listContracts(page, limit, typeFilter || undefined),
  });

  const contracts = data?.contracts ?? [];
  const pagination = data?.pagination;

  // Reset to page 1 when filter changes
  function handleTypeChange(newType: ProtocolTypeFilter) {
    setTypeFilter(newType);
    setPage(1);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <h1 style={{ fontSize: 22, marginBottom: 4 }}>Contract Registry</h1>
        <p style={{ color: "var(--muted)" }}>
          Registered Soroban smart contracts on the Stellar network.
        </p>
      </div>

      {/* Type filter */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <label htmlFor="type-filter" style={{ fontSize: 13, color: "var(--muted)" }}>
          Filter by type:
        </label>
        <select
          id="type-filter"
          value={typeFilter}
          onChange={(e) => handleTypeChange(e.target.value as ProtocolTypeFilter)}
          style={{
            padding: "4px 8px",
            borderRadius: 4,
            border: "1px solid var(--border)",
            background: "var(--bg)",
            color: "var(--text)",
            fontSize: 13,
          }}
        >
          {PROTOCOL_TYPES.map((t) => (
            <option key={t} value={t}>
              {TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      </div>

      <div className="card">
        {error && <p style={{ color: "#f85149" }}>{(error as Error).message}</p>}
        {isLoading && <p style={{ color: "var(--muted)" }}>Loading…</p>}
        {!isLoading && !error && contracts.length === 0 && (
          <p style={{ color: "var(--muted)" }}>No contracts registered yet.</p>
        )}
        {!isLoading && contracts.length > 0 && (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)", textAlign: "left" }}>
                <th style={{ padding: "8px 4px" }}>Name</th>
                <th style={{ padding: "8px 4px" }}>Contract ID</th>
                <th style={{ padding: "8px 4px" }}>Type</th>
                <th style={{ padding: "8px 4px" }}>Registered By</th>
                <th style={{ padding: "8px 4px" }}>Created At</th>
              </tr>
            </thead>
            <tbody>
              {contracts.map((c) => (
                <tr key={c.id} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ padding: "10px 4px" }}>
                    <div style={{ display: "flex", alignItems: "center" }}>
                      <Link to={`/contract/${c.id}`} style={{ fontWeight: 600 }}>
                        {c.name || truncateAddress(c.id)}
                      </Link>
                      {c.is_verified && <VerifiedBadge ledger={c.verified_ledger} />}
                    </div>
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
                    <span
                      style={{
                        fontSize: 11,
                        padding: "2px 7px",
                        borderRadius: 10,
                        background: "var(--border)",
                        color: "var(--muted)",
                        textTransform: "uppercase",
                        fontWeight: 600,
                        letterSpacing: "0.04em",
                      }}
                    >
                      {c.protocol_type ?? "other"}
                    </span>
                  </td>
                  <td style={{ padding: "10px 4px" }}>
                    <code style={{ fontSize: 12 }}>{truncateAddress(c.registered_by)}</code>
                  </td>
                  <td style={{ padding: "10px 4px", color: "var(--muted)", fontSize: 12 }}>
                    {new Date(c.created_at).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

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
