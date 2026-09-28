import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api";

// Issue #912: live "latest ledgers" strip on the home page. Home invalidates
// the ["ledgers", "latest"] query whenever a WebSocket event arrives from a
// newer ledger.
export default function LatestLedgers() {
  const { data } = useQuery({
    queryKey: ["ledgers", "latest"],
    queryFn: () => api.ledgers({ limit: 8 }),
  });
  const ledgers = data?.data ?? [];
  if (!ledgers.length) return null;
  return (
    <section aria-label="Latest ledgers" data-testid="latest-ledgers" className="card">
      <h2 style={{ fontSize: 15, margin: "0 0 8px" }}>Latest ledgers</h2>
      <div style={{ display: "flex", gap: 12, overflowX: "auto" }}>
        {ledgers.map((l) => (
          <Link key={l.ledger} to={`/ledger/${l.ledger}`} style={{ whiteSpace: "nowrap", fontSize: 13 }}>
            #{l.ledger.toLocaleString()} · {l.soroban_tx_count} tx
          </Link>
        ))}
      </div>
    </section>
  );
}
