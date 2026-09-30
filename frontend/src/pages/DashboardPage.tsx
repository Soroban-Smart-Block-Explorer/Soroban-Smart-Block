import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  getMe,
  logout,
  registerPasskey,
  removePasskey,
  regenerateRecoveryCodes,
  type Me,
} from "../services/accountApi";
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

/** Passkeys, recovery codes and session for a signed-in account (#933). */
function AccountSecurityPanel({ me, onChange }: { me: Me; onChange: () => void }) {
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  const act = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    }
  };

  return (
    <section className="card" aria-label="Account security" style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <strong>{me.account.email}</strong>
        <button type="button" onClick={() => act(logout)}>Sign out of account</button>
      </div>
      {error && <p role="alert">{error}</p>}
      <h3 style={{ fontSize: 14 }}>Passkeys</h3>
      <ul data-testid="passkey-list">
        {me.account.passkeys.map((p) => (
          <li key={p.id}>
            {p.name ?? "Passkey"} · {p.device_type === "multiDevice" ? "synced" : "this device"}
            {p.transports.includes("hybrid") ? " · cross-device" : ""} · added {new Date(p.created_at).toLocaleDateString()}{" "}
            <button type="button" onClick={() => act(() => removePasskey(p.id))}>Remove</button>
          </li>
        ))}
      </ul>
      <button type="button" onClick={() => act(() => registerPasskey())}>Add a passkey</button>
      <h3 style={{ fontSize: 14 }}>Recovery codes</h3>
      <p style={{ fontSize: 13, color: "var(--muted)" }}>
        {me.account.recovery_codes_remaining} unused. Recovery needs your email <em>and</em> one of these codes.
      </p>
      <button
        type="button"
        onClick={() => act(async () => setCodes((await regenerateRecoveryCodes()).recovery_codes))}
      >
        Generate new recovery codes
      </button>
      {codes && <pre data-testid="new-recovery-codes">{codes.join("\n")}</pre>}
    </section>
  );
}

export default function DashboardPage() {
  const [me, setMe] = useState<Me | null>(null);
  const loadMe = () => {
    getMe().then(setMe).catch(() => setMe(null));
  };
  useEffect(loadMe, []);

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
        {me ? (
          <AccountSecurityPanel me={me} onChange={loadMe} />
        ) : (
          <p style={{ fontSize: 13, marginTop: 16 }}>
            Prefer an account? <Link to="/login">Sign in with a passkey</Link>
          </p>
        )}
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

      {me && <AccountSecurityPanel me={me} onChange={loadMe} />}

      {tab === "keys" && <ApiKeysPanel />}
      {tab === "webhooks" && <WebhooksPanel />}
      {tab === "deliveries" && <WebhookDeliveriesPanel />}
    </div>
  );
}
