import { useState } from "react";
import { getStoredApiKey, setStoredApiKey, clearStoredApiKey } from "../services/dashboardApi";
import ApiKeysPanel from "../components/dashboard/ApiKeysPanel";
import WebhooksPanel from "../components/dashboard/WebhooksPanel";
import WebhookDeliveriesPanel from "../components/dashboard/WebhookDeliveriesPanel";

type Tab = "keys" | "webhooks" | "deliveries";

const TABS: { id: Tab; label: string }[] = [
  { id: "keys", label: "API Keys" },
  { id: "webhooks", label: "Webhook Subscriptions" },
  { id: "deliveries", label: "Webhook Deliveries" },
];

export default function DashboardPage() {
  const [apiKey, setApiKey] = useState(() => getStoredApiKey());
  const [inputKey, setInputKey] = useState("");
  const [tab, setTab] = useState<Tab>("keys");

  if (!apiKey) {
    return (
      <div className="card" style={{ maxWidth: 440, margin: "48px auto", padding: 24 }}>
        <h2 style={{ marginTop: 0 }}>Developer Dashboard</h2>
        <p style={{ color: "var(--muted)", fontSize: 14 }}>
          Enter one of your API keys to manage your keys and webhook subscriptions. The key is stored only in this
          browser (localStorage).
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = inputKey.trim();
            if (!trimmed) return;
            setStoredApiKey(trimmed);
            setApiKey(trimmed);
            setInputKey("");
          }}
          style={{ display: "flex", gap: 8 }}
        >
          <input
            type="password"
            value={inputKey}
            onChange={(e) => setInputKey(e.target.value)}
            placeholder="API key"
            style={{ flex: 1 }}
            autoFocus
          />
          <button type="submit">Unlock</button>
        </form>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Developer Dashboard</h2>
        <button
          type="button"
          onClick={() => {
            clearStoredApiKey();
            setApiKey(null);
          }}
          style={{
            background: "none",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: "6px 12px",
            cursor: "pointer",
            fontSize: 12,
            color: "var(--muted)",
          }}
        >
          Sign out
        </button>
      </div>

      <div style={{ display: "flex", gap: 16, borderBottom: "1px solid var(--border)", marginBottom: 16 }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            style={{
              background: "none",
              border: "none",
              borderBottom: tab === t.id ? "2px solid var(--accent)" : "2px solid transparent",
              color: tab === t.id ? "var(--text)" : "var(--muted)",
              padding: "8px 4px",
              cursor: "pointer",
              fontSize: 14,
              fontWeight: tab === t.id ? 600 : 400,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "keys" && <ApiKeysPanel />}
      {tab === "webhooks" && <WebhooksPanel />}
      {tab === "deliveries" && <WebhookDeliveriesPanel />}
    </div>
  );
}
