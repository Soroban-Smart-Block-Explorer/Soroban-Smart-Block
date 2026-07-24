import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import EventTable from "../components/EventTable";

const VALID_ADDRESS_RE = /^G[A-Z2-7]{55}$/;

export default function WalletPage() {
  const { address = "" } = useParams();

  const isValidAddress = VALID_ADDRESS_RE.test(address);

  const { data, isLoading } = useQuery({
    queryKey: ["wallet", address],
    queryFn: () => api.wallet(address),
    enabled: !!address && isValidAddress,
  });

  const events = data?.events ?? [];
  const horizonAccount = data?.horizon_account ?? null;
  const xlmBalance = horizonAccount?.balances?.find((b) => b.asset_type === "native");

  if (address && !isValidAddress) {
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
          <p style={{ color: "#ef4444" }}>Invalid wallet address format</p>
        </div>
      </div>
    );
  }

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

      {xlmBalance && (
        <div className="card">
          <h3 style={{ marginBottom: 4 }}>XLM Balance</h3>
          <p style={{ fontSize: 18, fontWeight: 600 }}>{xlmBalance.balance} XLM</p>
        </div>
      )}

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
