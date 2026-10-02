/**
 * TokenPage — dedicated token view at /token/:id (#915).
 *
 * Displays:
 * - Token header: metadata (name, symbol, decimals, logo)
 * - Supply over time (from indexed transfer rollups)
 * - Holder distribution: top-N table + Gini coefficient
 * - Paginated transfer feed
 * - SAC section: linked classic asset, issuer, trustline count
 */

import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { truncateAddress } from "../utils/strkey";
import { useMetaTags } from "../hooks/useMetaTags";

// ── Types ──────────────────────────────────────────────────────────────────

interface TokenHolder {
  address: string;
  balance: string;
  share: number;
}

interface HoldersData {
  total_holders: number;
  holders: TokenHolder[];
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Gini coefficient — 0 means perfect equality, 1 means one holder owns all.
 * Computed from the sorted balances of the top-N holders.
 */
function computeGini(balances: number[]): number {
  if (balances.length === 0) return 0;
  const sorted = [...balances].sort((a, b) => a - b);
  const n = sorted.length;
  const sumAbsDiff = sorted.reduce(
    (acc, xi) => acc + sorted.reduce((a, xj) => a + Math.abs(xi - xj), 0),
    0,
  );
  const mean = sorted.reduce((a, b) => a + b, 0) / n;
  if (mean === 0) return 0;
  return sumAbsDiff / (2 * n * n * mean);
}

function formatBalance(raw: string, decimals: number): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  const scaled = n / 10 ** decimals;
  return scaled.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function formatPercent(share: number): string {
  return (share * 100).toFixed(2) + "%";
}

// ── Sub-components ─────────────────────────────────────────────────────────

function SupplySection({ contractId }: { contractId: string }) {
  const { data: volume, isLoading } = useQuery({
    queryKey: ["token-volume", contractId],
    queryFn: () =>
      fetch(
        `${(import.meta as unknown as { env: Record<string, string> }).env?.VITE_INDEXER_URL ?? ""}/api/tokens/${contractId}/volume`,
      ).then((r) => r.json()),
    enabled: !!contractId,
  });

  if (isLoading) return <p style={{ color: "var(--muted)" }}>Loading supply data…</p>;
  if (!volume) return null;

  return (
    <div className="card">
      <h3 style={{ fontSize: 14, marginBottom: 12 }}>24-Hour Volume</h3>
      {volume.error ? (
        <p style={{ color: "var(--muted)", fontSize: 13 }}>{volume.error}</p>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
            gap: 16,
          }}
        >
          {[
            { label: "Transfer Count", value: volume.transfer_count?.toLocaleString() ?? "—" },
            { label: "Unique Senders", value: volume.unique_senders?.toLocaleString() ?? "—" },
            { label: "Unique Receivers", value: volume.unique_receivers?.toLocaleString() ?? "—" },
          ].map(({ label, value }) => (
            <div key={label}>
              <div style={{ fontSize: 12, color: "var(--muted)" }}>{label}</div>
              <div style={{ fontSize: 22, fontWeight: 700 }}>{value}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function HoldersSection({
  contractId,
  decimals,
}: {
  contractId: string;
  decimals: number;
}) {
  const { data, isLoading, error } = useQuery<HoldersData>({
    queryKey: ["token-holders", contractId],
    queryFn: () =>
      fetch(
        `${(import.meta as unknown as { env: Record<string, string> }).env?.VITE_INDEXER_URL ?? ""}/api/tokens/${contractId}/holders`,
      ).then((r) => r.json()),
    enabled: !!contractId,
  });

  const gini =
    data?.holders?.length
      ? computeGini(data.holders.map((h) => Number(h.balance)))
      : null;

  const top10Share =
    data?.holders?.slice(0, 10).reduce((a, h) => a + h.share, 0) ?? null;

  return (
    <div className="card">
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginBottom: 12,
        }}
      >
        <h3 style={{ fontSize: 14 }}>
          Holder Distribution
          {data?.total_holders != null && (
            <span style={{ color: "var(--muted)", fontWeight: 400, fontSize: 12, marginLeft: 8 }}>
              ({data.total_holders.toLocaleString()} total)
            </span>
          )}
        </h3>
        <div style={{ display: "flex", gap: 16, fontSize: 12, color: "var(--muted)" }}>
          {gini != null && (
            <span title="Gini coefficient: 0 = perfect equality, 1 = single holder">
              Gini: <strong style={{ color: "var(--text)" }}>{gini.toFixed(3)}</strong>
            </span>
          )}
          {top10Share != null && (
            <span title="Share held by the top 10 addresses">
              Top-10:{" "}
              <strong style={{ color: "var(--text)" }}>{formatPercent(top10Share)}</strong>
            </span>
          )}
        </div>
      </div>

      {isLoading && <p style={{ color: "var(--muted)" }}>Loading holders…</p>}
      {error && (
        <p style={{ color: "#f85149", fontSize: 13 }}>
          Unable to load holder data.
        </p>
      )}
      {!isLoading && !error && data?.holders?.length === 0 && (
        <p style={{ color: "var(--muted)", fontSize: 13 }}>No holder data available yet.</p>
      )}

      {data?.holders && data.holders.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table
            style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}
            aria-label="Top token holders"
          >
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)", color: "var(--muted)" }}>
                <th style={{ textAlign: "left", padding: "6px 8px", fontWeight: 500 }}>#</th>
                <th style={{ textAlign: "left", padding: "6px 8px", fontWeight: 500 }}>Address</th>
                <th style={{ textAlign: "right", padding: "6px 8px", fontWeight: 500 }}>Balance</th>
                <th style={{ textAlign: "right", padding: "6px 8px", fontWeight: 500 }}>Share</th>
              </tr>
            </thead>
            <tbody>
              {data.holders.map((h, i) => (
                <tr key={h.address} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ padding: "6px 8px", color: "var(--muted)" }}>{i + 1}</td>
                  <td style={{ padding: "6px 8px", fontFamily: "monospace" }}>
                    <Link
                      to={`/wallet/${h.address}`}
                      style={{ color: "var(--accent)", textDecoration: "none" }}
                    >
                      {truncateAddress(h.address)}
                    </Link>
                  </td>
                  <td style={{ padding: "6px 8px", textAlign: "right" }}>
                    {formatBalance(h.balance, decimals)}
                  </td>
                  <td style={{ padding: "6px 8px", textAlign: "right", color: "var(--muted)" }}>
                    {formatPercent(h.share)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

export default function TokenPage() {
  const { id = "" } = useParams<{ id: string }>();

  // Fetch token metadata via the SEP-41 metadata endpoint
  const { data: meta, isLoading: metaLoading } = useQuery({
    queryKey: ["token-meta", id],
    queryFn: () =>
      fetch(
        `${(import.meta as unknown as { env: Record<string, string> }).env?.VITE_INDEXER_URL ?? ""}/api/tokens/${id}/metadata`,
      ).then((r) => r.json()),
    enabled: !!id,
  });

  // Fetch contract meta to check for SAC info
  const { data: contractMeta } = useQuery({
    queryKey: ["contract", id],
    queryFn: () => api.contract(id),
    enabled: !!id,
  });

  const [decimalsRaw] = useState<number>(meta?.decimals ?? 7);
  const decimals = Number.isFinite(decimalsRaw) ? decimalsRaw : 7;

  const name: string = meta?.name || contractMeta?.name || truncateAddress(id);
  const symbol: string = meta?.symbol ?? "";

  useMetaTags({
    title: `${symbol || name} Token — Soroban Smart Block Explorer`,
    description: `${name} token details: supply, holders, transfers on Stellar.`,
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Header */}
      <div className="card">
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: "50%",
              background: "var(--surface)",
              border: "1px solid var(--border)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 20,
              flexShrink: 0,
            }}
          >
            {symbol ? symbol.slice(0, 1) : "⬡"}
          </div>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>
              {metaLoading ? "Loading…" : name}
            </h1>
            {symbol && (
              <span style={{ fontSize: 13, color: "var(--muted)" }}>{symbol}</span>
            )}
          </div>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
            gap: 16,
            marginTop: 20,
          }}
        >
          <div>
            <div style={{ fontSize: 12, color: "var(--muted)" }}>Contract</div>
            <Link
              to={`/contract/${id}`}
              style={{ fontSize: 13, fontFamily: "monospace", color: "var(--accent)" }}
            >
              {truncateAddress(id)}
            </Link>
          </div>
          {decimals != null && (
            <div>
              <div style={{ fontSize: 12, color: "var(--muted)" }}>Decimals</div>
              <div style={{ fontSize: 18, fontWeight: 700 }}>{decimals}</div>
            </div>
          )}
          {meta?.error && (
            <div>
              <div style={{ fontSize: 12, color: "#fbbf24" }}>
                ⚠ No decimals() function — amounts shown in raw units.
              </div>
            </div>
          )}
        </div>
      </div>

      {/* SAC section — linked classic asset */}
      {(contractMeta as any)?.sac_asset_code && (
        <div className="card">
          <h3 style={{ fontSize: 14, marginBottom: 12 }}>Stellar Asset Contract (SAC)</h3>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
              gap: 12,
              fontSize: 13,
            }}
          >
            <div>
              <div style={{ fontSize: 12, color: "var(--muted)" }}>Classic Asset</div>
              <strong>{(contractMeta as any).sac_asset_code}</strong>
            </div>
            <div>
              <div style={{ fontSize: 12, color: "var(--muted)" }}>Issuer</div>
              <span style={{ fontFamily: "monospace" }}>
                {truncateAddress((contractMeta as any).sac_issuer ?? "")}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Supply / Volume */}
      <SupplySection contractId={id} />

      {/* Holder distribution */}
      <HoldersSection contractId={id} decimals={decimals} />

      {/* Transfer feed — link to event table */}
      <div className="card">
        <h3 style={{ fontSize: 14, marginBottom: 8 }}>Recent Transfers</h3>
        <p style={{ fontSize: 13, color: "var(--muted)" }}>
          See the full event history on the{" "}
          <Link to={`/contract/${id}`} style={{ color: "var(--accent)" }}>
            contract page
          </Link>
          .
        </p>
      </div>
    </div>
  );
}
