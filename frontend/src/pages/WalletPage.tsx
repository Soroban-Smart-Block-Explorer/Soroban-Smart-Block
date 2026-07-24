import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import EventTable from "../components/EventTable";

export default function WalletPage() {
  const { address = "" } = useParams();

  const { data: events = [], isLoading } = useQuery({
    queryKey: ["wallet", address],
    queryFn: () => api.wallet(address),
    enabled: !!address,
  });

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
        >
          {address}
        </code>
      </div>

      <div className="card">
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
