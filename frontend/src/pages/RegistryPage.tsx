import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { truncateAddress } from "../utils/strkey";

export default function RegistryPage() {
  const [page, setPage] = useState(1);
  const limit = 25;

  const { data, isLoading, error } = useQuery({
    queryKey: ["contracts", "list", page, limit],
    queryFn: () => api.listContracts(page, limit),
  });

  const contracts = data?.contracts ?? [];
  const pagination = data?.pagination;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <h1 style={{ fontSize: 22, marginBottom: 4 }}>Contract Registry</h1>
        <p style={{ color: "var(--muted)" }}>
          Registered Soroban smart contracts on the Stellar network.
        </p>
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
                <th style={{ padding: "8px 4px" }}>Registered By</th>
                <th style={{ padding: "8px 4px" }}>Created At</th>
              </tr>
            </thead>
            <tbody>
              {contracts.map((c) => (
                <tr key={c.id} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ padding: "10px 4px" }}>
                    <Link to={`/contract/${c.id}`} style={{ fontWeight: 600 }}>
                      {c.name || truncateAddress(c.id)}
                    </Link>
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
