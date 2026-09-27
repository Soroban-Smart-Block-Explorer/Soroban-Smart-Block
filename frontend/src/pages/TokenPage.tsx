/**
 * TokenPage — /token/:id
 *
 * Dedicated view for a SEP-41 token contract answering:
 *   - Metadata (name, symbol, decimals) with SAC linkage
 *   - Supply over time (chart + accessible table)
 *   - Holder distribution (Gini, top-N share, histogram + table)
 *   - Paginated transfer feed
 *
 * Issue #915.
 */
import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { truncateAddress } from "../utils/strkey";
import { useMetaTags } from "../hooks/useMetaTags";

function pct(n: number | null): string {
  if (n === null) return "—";
  return `${(n * 100).toFixed(1)}%`;
}

function formatBalance(raw: string, decimals: number): string {
  try {
    const n = BigInt(raw.split(".")[0]);
    const d = 10n ** BigInt(decimals);
    const whole = n / d;
    const frac = n % d;
    return `${whole}.${frac.toString().padStart(decimals, "0").slice(0, 4)}`;
  } catch {
    return raw;
  }
}

export default function TokenPage() {
  const { id } = useParams<{ id: string }>();
  const contractId = id ?? "";

  useMetaTags({ title: contractId ? `Token ${truncateAddress(contractId)}` : "Token", description: "SEP-41 token supply, holders, and transfer history" });

  const [supplyDays, setSupplyDays] = useState(30);
  const [transferCursor, setTransferCursor] = useState<number | undefined>(undefined);
  const [prevCursors, setPrevCursors] = useState<(number | undefined)[]>([]);

  const { data: summary, isLoading: loadingSummary, error: summaryError } = useQuery({
    queryKey: ["tokenSummary", contractId],
    queryFn: () => api.tokenSummary(contractId),
    enabled: !!contractId,
  });

  const { data: supplySeries, isLoading: loadingSupply } = useQuery({
    queryKey: ["tokenSupplySeries", contractId, supplyDays],
    queryFn: () => api.tokenSupplySeries(contractId, supplyDays),
    enabled: !!contractId,
  });

  const { data: distribution, isLoading: loadingDist } = useQuery({
    queryKey: ["tokenDistribution", contractId],
    queryFn: () => api.tokenDistribution(contractId),
    enabled: !!contractId,
  });

  const { data: transfers, isLoading: loadingTransfers } = useQuery({
    queryKey: ["tokenTransfers", contractId, transferCursor],
    queryFn: () => api.tokenTransfers(contractId, { limit: 25, after: transferCursor }),
    enabled: !!contractId,
  });

  if (!contractId) {
    return <p style={{ color: "var(--muted)", padding: 32 }}>No contract ID provided.</p>;
  }

  if (summaryError) {
    return (
      <div className="card" style={{ color: "#f87171" }}>
        Failed to load token: {(summaryError as Error).message}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Header */}
      <div className="card" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {loadingSummary ? (
          <p style={{ color: "var(--muted)" }}>Loading…</p>
        ) : summary ? (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>
                {summary.name || summary.symbol || truncateAddress(contractId)}
              </h1>
              {summary.symbol && (
                <span
                  style={{
                    padding: "2px 10px",
                    background: "rgba(139,92,246,0.12)",
                    border: "1px solid #8b5cf6",
                    borderRadius: 6,
                    color: "#a78bfa",
                    fontSize: 13,
                    fontWeight: 600,
                  }}
                >
                  {summary.symbol}
                </span>
              )}
              {summary.is_non_standard && (
                <span
                  style={{
                    padding: "2px 10px",
                    background: "rgba(245,158,11,0.1)",
                    border: "1px solid #f59e0b",
                    borderRadius: 6,
                    color: "#fbbf24",
                    fontSize: 12,
                  }}
                  title="Token does not fully implement SEP-41 — some metrics may be unreliable."
                >
                  ⚠ Non-standard token
                </span>
              )}
            </div>
            <code style={{ fontSize: 12, color: "var(--muted)" }}>{contractId}</code>

            <dl
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
                gap: "8px 20px",
                margin: "8px 0 0",
                fontSize: 13,
              }}
            >
              <div>
                <dt style={{ color: "var(--muted)", fontSize: 11 }}>Decimals</dt>
                <dd style={{ margin: 0, fontWeight: 600 }}>
                  {summary.decimals === 7 && summary.is_non_standard ? (
                    <span title="No decimals() function — raw units shown">
                      raw units
                    </span>
                  ) : (
                    summary.decimals
                  )}
                </dd>
              </div>
              <div>
                <dt style={{ color: "var(--muted)", fontSize: 11 }}>Total Supply</dt>
                <dd style={{ margin: 0, fontWeight: 600 }}>
                  {summary.total_supply
                    ? formatBalance(summary.total_supply, summary.decimals)
                    : "—"}
                </dd>
              </div>
              <div>
                <dt style={{ color: "var(--muted)", fontSize: 11 }}>Holders</dt>
                <dd style={{ margin: 0, fontWeight: 600 }}>{summary.total_holders.toLocaleString()}</dd>
              </div>
            </dl>

            {/* SAC section */}
            {summary.sac && (
              <div
                style={{
                  marginTop: 8,
                  padding: "10px 14px",
                  background: "rgba(16,185,129,0.06)",
                  border: "1px solid #10b981",
                  borderRadius: 8,
                  fontSize: 13,
                }}
              >
                <strong style={{ color: "#34d399" }}>Stellar Asset Contract (SAC)</strong>
                <div style={{ marginTop: 4, color: "var(--muted)" }}>
                  Wraps classic asset{" "}
                  <strong style={{ color: "var(--text)" }}>{summary.sac.asset_code}</strong>
                  {summary.sac.asset_issuer && (
                    <>
                      {" "}issued by{" "}
                      <code style={{ fontSize: 11 }}>{truncateAddress(summary.sac.asset_issuer)}</code>
                    </>
                  )}
                </div>
              </div>
            )}

            <div style={{ marginTop: 4 }}>
              <Link
                to={`/contract/${contractId}`}
                style={{ fontSize: 12, color: "var(--accent)" }}
              >
                View contract page →
              </Link>
            </div>
          </>
        ) : null}
      </div>

      {/* Supply over time */}
      <div className="card" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ margin: 0, fontSize: 15 }}>Supply Over Time</h2>
          <div style={{ display: "flex", gap: 6 }}>
            {[7, 30, 90, 365].map((d) => (
              <button
                key={d}
                onClick={() => setSupplyDays(d)}
                style={{
                  padding: "3px 10px",
                  fontSize: 12,
                  background: supplyDays === d ? "var(--accent)" : "var(--surface)",
                  color: supplyDays === d ? "#0d1117" : "var(--muted)",
                  border: `1px solid ${supplyDays === d ? "var(--accent)" : "var(--border)"}`,
                  borderRadius: 4,
                  cursor: "pointer",
                }}
              >
                {d}d
              </button>
            ))}
          </div>
        </div>

        {loadingSupply ? (
          <p style={{ color: "var(--muted)", fontSize: 13 }}>Loading series…</p>
        ) : !supplySeries?.series.length ? (
          <p style={{ color: "var(--muted)", fontSize: 13 }}>No supply data for this period.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table
              aria-label="Supply series data"
              style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}
            >
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  <th style={{ textAlign: "left", padding: "6px 8px", color: "var(--muted)" }}>Day</th>
                  <th style={{ textAlign: "right", padding: "6px 8px", color: "var(--muted)" }}>Minted</th>
                  <th style={{ textAlign: "right", padding: "6px 8px", color: "var(--muted)" }}>Burned</th>
                </tr>
              </thead>
              <tbody>
                {supplySeries.series.map((row, i) => (
                  <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
                    <td style={{ padding: "6px 8px" }}>{new Date(row.day).toLocaleDateString()}</td>
                    <td style={{ padding: "6px 8px", textAlign: "right", color: "#34d399" }}>
                      {Number(row.minted).toLocaleString()}
                    </td>
                    <td style={{ padding: "6px 8px", textAlign: "right", color: "#f87171" }}>
                      {Number(row.burned).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Holder distribution */}
      <div className="card" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 15 }}>Holder Distribution</h2>

        {loadingDist ? (
          <p style={{ color: "var(--muted)", fontSize: 13 }}>Computing distribution…</p>
        ) : distribution ? (
          <>
            {summary?.is_non_standard && (
              <p style={{ fontSize: 12, color: "#f59e0b", margin: 0 }}>
                ⚠ Non-standard (rebasing) token — concentration metrics may be unreliable.
              </p>
            )}
            <dl
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))",
                gap: "8px 16px",
                fontSize: 13,
                margin: 0,
              }}
            >
              <div>
                <dt style={{ color: "var(--muted)", fontSize: 11 }}>Gini coefficient</dt>
                <dd style={{ margin: 0, fontWeight: 600 }}>
                  {distribution.gini !== null ? distribution.gini.toFixed(3) : "—"}
                </dd>
              </div>
              <div>
                <dt style={{ color: "var(--muted)", fontSize: 11 }}>Top 10 share</dt>
                <dd style={{ margin: 0, fontWeight: 600 }}>{pct(distribution.top10_share)}</dd>
              </div>
              <div>
                <dt style={{ color: "var(--muted)", fontSize: 11 }}>Top 100 share</dt>
                <dd style={{ margin: 0, fontWeight: 600 }}>{pct(distribution.top100_share)}</dd>
              </div>
              <div>
                <dt style={{ color: "var(--muted)", fontSize: 11 }}>Total holders</dt>
                <dd style={{ margin: 0, fontWeight: 600 }}>{distribution.total_holders.toLocaleString()}</dd>
              </div>
            </dl>

            {distribution.histogram.length > 0 && (
              <div style={{ overflowX: "auto" }}>
                <table
                  aria-label="Balance histogram"
                  style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}
                >
                  <thead>
                    <tr style={{ borderBottom: "1px solid var(--border)" }}>
                      <th style={{ textAlign: "left", padding: "6px 8px", color: "var(--muted)" }}>Balance range</th>
                      <th style={{ textAlign: "right", padding: "6px 8px", color: "var(--muted)" }}>Holders</th>
                      <th style={{ textAlign: "left", padding: "6px 8px", color: "var(--muted)" }}>Bar</th>
                    </tr>
                  </thead>
                  <tbody>
                    {distribution.histogram.map((bucket, i) => {
                      const maxCount = Math.max(...distribution.histogram.map((b) => b.count), 1);
                      return (
                        <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
                          <td style={{ padding: "6px 8px", fontFamily: "monospace" }}>
                            {bucket.range_min.toFixed(2)} – {bucket.range_max.toFixed(2)}
                          </td>
                          <td style={{ padding: "6px 8px", textAlign: "right" }}>{bucket.count}</td>
                          <td style={{ padding: "6px 8px" }}>
                            <div
                              style={{
                                height: 8,
                                width: `${(bucket.count / maxCount) * 120}px`,
                                background: "var(--accent)",
                                borderRadius: 2,
                              }}
                              aria-hidden
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : null}
      </div>

      {/* Transfer feed */}
      <div className="card" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 15 }}>Transfers</h2>

        {loadingTransfers ? (
          <p style={{ color: "var(--muted)", fontSize: 13 }}>Loading transfers…</p>
        ) : !transfers?.transfers.length ? (
          <p style={{ color: "var(--muted)", fontSize: 13 }}>No transfers found.</p>
        ) : (
          <>
            <div style={{ overflowX: "auto" }}>
              <table
                aria-label="Token transfers"
                style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}
              >
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--border)" }}>
                    <th style={{ textAlign: "left", padding: "6px 8px", color: "var(--muted)" }}>Seq</th>
                    <th style={{ textAlign: "left", padding: "6px 8px", color: "var(--muted)" }}>Ledger</th>
                    <th style={{ textAlign: "left", padding: "6px 8px", color: "var(--muted)" }}>Description</th>
                    <th style={{ textAlign: "left", padding: "6px 8px", color: "var(--muted)" }}>Tx</th>
                    <th style={{ textAlign: "left", padding: "6px 8px", color: "var(--muted)" }}>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {transfers.transfers.map((t) => (
                    <tr key={t.seq} style={{ borderBottom: "1px solid var(--border)" }}>
                      <td style={{ padding: "6px 8px" }}>
                        <Link to={`/event/${t.seq}`} style={{ color: "var(--accent)" }}>{t.seq}</Link>
                      </td>
                      <td style={{ padding: "6px 8px" }}>{t.ledger}</td>
                      <td style={{ padding: "6px 8px", color: "var(--muted)", maxWidth: 300 }}>
                        {t.decoded_text}
                      </td>
                      <td style={{ padding: "6px 8px" }}>
                        <Link to={`/tx/${t.tx_hash}`} style={{ color: "var(--accent)", fontFamily: "monospace", fontSize: 11 }}>
                          {t.tx_hash.slice(0, 10)}…
                        </Link>
                      </td>
                      <td style={{ padding: "6px 8px", color: "var(--muted)" }}>
                        {new Date(t.created_at).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}>
              {prevCursors.length > 0 && (
                <button
                  onClick={() => {
                    const prev = [...prevCursors];
                    const cursor = prev.pop();
                    setPrevCursors(prev);
                    setTransferCursor(cursor);
                  }}
                  style={{
                    padding: "4px 12px",
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                    cursor: "pointer",
                    color: "var(--muted)",
                  }}
                >
                  ← Prev
                </button>
              )}
              {transfers.next_cursor !== null && (
                <button
                  onClick={() => {
                    setPrevCursors((p) => [...p, transferCursor]);
                    setTransferCursor(transfers.next_cursor ?? undefined);
                  }}
                  style={{
                    padding: "4px 12px",
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                    cursor: "pointer",
                    color: "var(--muted)",
                  }}
                >
                  Next →
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
