import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { dashboardApi, type ApiKeyRecord } from "../../services/dashboardApi";

const TIERS = ["free", "pro", "enterprise"];

function RevealedKey({ label, value, onDismiss }: { label: string; value: string; onDismiss: () => void }) {
  return (
    <div
      className="card"
      style={{ padding: 12, marginBottom: 12, border: "1px solid var(--accent)", fontSize: 13 }}
    >
      <strong>{label}</strong> — save this now, it will not be shown again:
      <div style={{ display: "flex", gap: 8, marginTop: 6, alignItems: "center" }}>
        <code style={{ flex: 1, wordBreak: "break-all", background: "var(--border)", padding: "4px 8px", borderRadius: 4 }}>
          {value}
        </code>
        <button type="button" onClick={onDismiss} style={{ fontSize: 12 }}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

function AllowlistEditor({ apiKeyId, allowedIps }: { apiKeyId: string; allowedIps: string[] | null }) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState((allowedIps ?? []).join(", "));

  const mutation = useMutation({
    mutationFn: (ips: string[]) => dashboardApi.updateAllowedIps(apiKeyId, ips),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["dashboard", "api-keys"] }),
  });

  return (
    <div style={{ marginTop: 6, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      <label style={{ fontSize: 12, color: "var(--muted)" }}>IP allowlist (CIDR, comma-separated):</label>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="e.g. 203.0.113.0/24, 198.51.100.7"
        style={{ flex: 1, minWidth: 200, fontSize: 12 }}
      />
      <button
        type="button"
        disabled={mutation.isPending}
        onClick={() => {
          const ips = value
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          mutation.mutate(ips);
        }}
      >
        {mutation.isPending ? "Saving…" : "Save allowlist"}
      </button>
      {mutation.isError && (
        <span style={{ color: "#e5484d", fontSize: 12 }} role="alert">
          {(mutation.error as Error).message}
        </span>
      )}
    </div>
  );
}

function UsageRow({ apiKeyId }: { apiKeyId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["dashboard", "api-key-usage", apiKeyId],
    queryFn: () => dashboardApi.apiKeyUsage(apiKeyId),
  });

  if (isLoading || !data) return <span style={{ color: "var(--muted)", fontSize: 12 }}>loading usage…</span>;
  return (
    <span style={{ color: "var(--muted)", fontSize: 12 }}>
      {data.today} today · {data.this_month} this month · {data.events_received} events received
    </span>
  );
}

export default function ApiKeysPanel() {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [tier, setTier] = useState("free");
  const [expiresAt, setExpiresAt] = useState("");
  const [revealed, setRevealed] = useState<{ label: string; value: string } | null>(null);

  const keysQuery = useQuery({ queryKey: ["dashboard", "api-keys"], queryFn: dashboardApi.listApiKeys });

  const createMutation = useMutation({
    mutationFn: () => dashboardApi.createApiKey({ name, tier, expires_at: expiresAt || undefined }),
    onSuccess: (result) => {
      setRevealed({ label: `New key "${result.record.name}"`, value: result.key });
      setName("");
      setExpiresAt("");
      queryClient.invalidateQueries({ queryKey: ["dashboard", "api-keys"] });
    },
  });

  const rotateMutation = useMutation({
    mutationFn: (id: string) => dashboardApi.rotateApiKey(id),
    onSuccess: (result) => {
      setRevealed({ label: `Rotated key "${result.record.name}"`, value: result.key });
      queryClient.invalidateQueries({ queryKey: ["dashboard", "api-keys"] });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => dashboardApi.revokeApiKey(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["dashboard", "api-keys"] }),
  });

  return (
    <div>
      {revealed && (
        <RevealedKey label={revealed.label} value={revealed.value} onDismiss={() => setRevealed(null)} />
      )}

      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <h3 style={{ marginTop: 0, fontSize: 15 }}>Create a new API key</h3>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            createMutation.mutate();
          }}
          style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}
        >
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Key name" style={{ flex: 1, minWidth: 160 }} />
          <select value={tier} onChange={(e) => setTier(e.target.value)}>
            {TIERS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <input
            type="date"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
            title="Expiry date (optional)"
          />
          <button type="submit" disabled={createMutation.isPending}>
            {createMutation.isPending ? "Creating…" : "Create key"}
          </button>
        </form>
        {createMutation.isError && (
          <p style={{ color: "#e5484d", fontSize: 12 }} role="alert">
            {(createMutation.error as Error).message}
          </p>
        )}
      </div>

      {keysQuery.isLoading && <p style={{ color: "var(--muted)" }}>Loading keys…</p>}
      {keysQuery.isError && (
        <p style={{ color: "#e5484d" }} role="alert">
          {(keysQuery.error as Error).message}
        </p>
      )}

      {keysQuery.data?.map((key: ApiKeyRecord) => (
        <div key={key.id} className="card" style={{ padding: 12, marginBottom: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
            <div>
              <strong>{key.name}</strong>{" "}
              <span className="badge">{key.tier}</span>{" "}
              {key.revoked && <span className="badge" style={{ color: "#e5484d" }}>revoked</span>}
              <div style={{ fontSize: 12, color: "var(--muted)" }}>
                {key.key_prefix}… · created {new Date(key.created_at).toLocaleDateString()}
                {key.expires_at && ` · expires ${new Date(key.expires_at).toLocaleDateString()}`}
              </div>
              <div style={{ marginTop: 4 }}>
                <UsageRow apiKeyId={key.id} />
              </div>
              <AllowlistEditor apiKeyId={key.id} allowedIps={key.allowed_ips} />
            </div>
            <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
              <button type="button" disabled={key.revoked} onClick={() => rotateMutation.mutate(key.id)}>
                Rotate
              </button>
              <button
                type="button"
                disabled={key.revoked}
                onClick={() => {
                  if (confirm(`Revoke key "${key.name}"? This cannot be undone.`)) revokeMutation.mutate(key.id);
                }}
              >
                Revoke
              </button>
            </div>
          </div>
        </div>
      ))}

      {keysQuery.data?.length === 0 && <p style={{ color: "var(--muted)" }}>No API keys yet.</p>}
    </div>
  );
}
