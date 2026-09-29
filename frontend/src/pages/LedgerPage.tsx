import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, LedgerNotFoundError } from "../api";

// Issue #912: ledger detail page — header, resource utilization vs. network
// limits, Soroban transactions with narratives, keyboard prev/next.

function UtilBar({ label, value }: { label: string; value: number | null }) {
  const pct = value == null ? null : Math.round(value * 100);
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
        <span>{label}</span>
        <span>{pct == null ? "limit unknown" : `${pct}%`}</span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuenow={pct ?? undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        style={{ height: 6, background: "var(--border)", borderRadius: 3 }}
      >
        <div
          style={{
            width: `${pct ?? 0}%`,
            height: "100%",
            borderRadius: 3,
            background: (pct ?? 0) >= 90 ? "var(--danger, #d33)" : "var(--accent)",
          }}
        />
      </div>
    </div>
  );
}

export default function LedgerPage() {
  const { seq = "" } = useParams();
  const navigate = useNavigate();
  const n = Number(seq);
  const valid = Number.isInteger(n) && n > 0;
  const { data, error, isLoading } = useQuery({
    queryKey: ["ledger", n],
    queryFn: () => api.ledger(n),
    enabled: valid,
    retry: (count, err) => !(err instanceof LedgerNotFoundError) && count < 2,
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (e.key === "ArrowLeft" && data?.prev != null) navigate(`/ledger/${data.prev}`);
      if (e.key === "ArrowRight" && data?.next != null) navigate(`/ledger/${data.next}`);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [data, navigate]);

  if (!valid) return <p>Invalid ledger sequence.</p>;
  if (isLoading) return <p role="status">Loading ledger…</p>;
  if (error instanceof LedgerNotFoundError) {
    return (
      <div className="card" role="alert">
        <h1>Ledger not found</h1>
        <p>Ledger {n.toLocaleString()} has not closed or has not been indexed yet.</p>
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="card" role="alert">
        <h1>Ledger unavailable</h1>
        <p>{(error as Error | null)?.message ?? "Unknown error"}</p>
      </div>
    );
  }

  const nav = (
    <nav aria-label="Ledger navigation" style={{ display: "flex", gap: 12 }}>
      {data.prev != null ? <Link to={`/ledger/${data.prev}`}>← Ledger {data.prev.toLocaleString()}</Link> : <span />}
      {data.next != null && <Link to={`/ledger/${data.next}`}>Ledger {data.next.toLocaleString()} →</Link>}
    </nav>
  );

  if (data.status === "not_indexed") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <h1>Ledger {n.toLocaleString()}</h1>
        <div className="card" role="status" data-testid="ledger-not-indexed">
          <p>This ledger is older than the indexer's retention window and is not indexed.</p>
        </div>
        {nav}
      </div>
    );
  }

  const txs = data.transactions ?? [];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <h1>Ledger {n.toLocaleString()}</h1>
      {nav}

      {data.status === "gap" && data.gap && (
        <div className="card" role="alert" data-testid="ledger-gap-banner">
          This ledger falls in a known indexing gap (ledgers {data.gap.from_ledger.toLocaleString()}–
          {data.gap.to_ledger.toLocaleString()}, gap #{data.gap.id}, {data.gap.status}); data may be incomplete.{" "}
          <Link to={`/admin/jobs?gap=${data.gap.id}`}>Open gap record in admin tooling</Link>
        </div>
      )}

      <section className="card">
        <h2>Summary</h2>
        <p>
          <strong>Indexing status:</strong> {data.status === "indexed" ? "fully indexed" : "gap"}
        </p>
        {data.hash && (
          <p>
            <strong>Hash:</strong> <code>{data.hash}</code>
          </p>
        )}
        {data.closed_at && (
          <p>
            <strong>Close time:</strong> {new Date(data.closed_at).toLocaleString()}
          </p>
        )}
        <p>
          <strong>Protocol version:</strong> {data.protocol_version ?? "unknown"}
        </p>
        <p>
          <strong>Soroban transactions:</strong> {data.soroban_tx_count ?? 0} · <strong>Events:</strong>{" "}
          {data.event_count ?? 0}
        </p>
        {data.fees && (
          <p>
            <strong>Inclusion fee (stroops):</strong> p10 {data.fees.p10 ?? "–"} · p50 {data.fees.p50 ?? "–"} · p90{" "}
            {data.fees.p90 ?? "–"} · p99 {data.fees.p99 ?? "–"}
          </p>
        )}
      </section>

      {data.utilization && (
        <section className="card">
          <h2>Resource utilization vs. network limits</h2>
          <UtilBar label="Transactions" value={data.utilization.tx_count ?? null} />
          <UtilBar label="CPU instructions" value={data.utilization.instructions ?? null} />
          <UtilBar label="Read bytes" value={data.utilization.read_bytes ?? null} />
          <UtilBar label="Write bytes" value={data.utilization.write_bytes ?? null} />
        </section>
      )}

      <section className="card">
        <h2>Soroban transactions</h2>
        {txs.length === 0 ? (
          <p data-testid="ledger-empty">No Soroban transactions in this ledger.</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {txs.map((tx) => (
              <li key={tx.hash} style={{ padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
                <Link to={`/tx/${tx.hash}`}>
                  <code>{tx.hash.slice(0, 16)}…</code>
                </Link>
                {tx.status && <span style={{ marginLeft: 8, color: "var(--muted)" }}>{tx.status}</span>}
                {tx.narratives.map((nar, i) => (
                  <div key={i} style={{ fontSize: 13 }}>
                    {nar.description}
                  </div>
                ))}
              </li>
            ))}
          </ul>
        )}
      </section>
      <p style={{ color: "var(--muted)", fontSize: 12 }}>Tip: use ← / → to move between ledgers.</p>
    </div>
  );
}
