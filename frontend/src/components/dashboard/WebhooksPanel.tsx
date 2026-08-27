import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { dashboardApi } from "../../services/dashboardApi";
import ContractSelect from "./ContractSelect";

export default function WebhooksPanel() {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState("");
  const [contractId, setContractId] = useState("");
  const [functionFilter, setFunctionFilter] = useState("");
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; ok: boolean } | null>(null);

  const webhooksQuery = useQuery({ queryKey: ["webhooks"], queryFn: dashboardApi.listWebhooks });

  const createMutation = useMutation({
    mutationFn: () =>
      dashboardApi.createWebhook({
        url,
        contract_id: contractId || null,
        function_filter: functionFilter || null,
      }),
    onSuccess: (result) => {
      setRevealedSecret(result.secret);
      setUrl("");
      setContractId("");
      setFunctionFilter("");
      queryClient.invalidateQueries({ queryKey: ["webhooks"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => dashboardApi.deleteWebhook(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["webhooks"] }),
  });

  const testMutation = useMutation({
    mutationFn: (id: string) => dashboardApi.testFireWebhook(id),
    onSuccess: (delivery, id) => {
      setTestResult({ id, ok: !!delivery.delivered_at });
      queryClient.invalidateQueries({ queryKey: ["webhooks"] });
    },
    onError: (_err, id) => setTestResult({ id, ok: false }),
  });

  return (
    <div>
      {revealedSecret && (
        <div className="card" style={{ padding: 12, marginBottom: 12, border: "1px solid var(--accent)", fontSize: 13 }}>
          <strong>Signing secret</strong> — save this now, it will not be shown again:
          <div style={{ display: "flex", gap: 8, marginTop: 6, alignItems: "center" }}>
            <code style={{ flex: 1, wordBreak: "break-all", background: "var(--border)", padding: "4px 8px", borderRadius: 4 }}>
              {revealedSecret}
            </code>
            <button type="button" onClick={() => setRevealedSecret(null)} style={{ fontSize: 12 }}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <h3 style={{ marginTop: 0, fontSize: 15 }}>New webhook subscription</h3>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!url.trim()) return;
            createMutation.mutate();
          }}
          style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}
        >
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://your-endpoint.example/webhook"
            style={{ flex: 1, minWidth: 240 }}
          />
          <ContractSelect
            contractId={contractId}
            functionFilter={functionFilter}
            onContractChange={setContractId}
            onFunctionChange={setFunctionFilter}
          />
          <button type="submit" disabled={createMutation.isPending}>
            {createMutation.isPending ? "Creating…" : "Create webhook"}
          </button>
        </form>
        {createMutation.isError && (
          <p style={{ color: "#e5484d", fontSize: 12 }} role="alert">
            {(createMutation.error as Error).message}
          </p>
        )}
      </div>

      {webhooksQuery.isLoading && <p style={{ color: "var(--muted)" }}>Loading webhooks…</p>}
      {webhooksQuery.isError && (
        <p style={{ color: "#e5484d" }} role="alert">
          {(webhooksQuery.error as Error).message}
        </p>
      )}

      {webhooksQuery.data?.map((sub) => (
        <div key={sub.id} className="card" style={{ padding: 12, marginBottom: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
            <div>
              <code style={{ fontSize: 13 }}>{sub.url}</code>
              <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>
                {sub.contract_id ?? "all contracts"} · {sub.function_filter ?? "all functions"}
              </div>
              <div style={{ marginTop: 4 }}>
                {sub.active ? (
                  <span className="badge">active</span>
                ) : (
                  <span className="badge" style={{ color: "#e5484d" }}>
                    auto-disabled ({sub.failure_count} failures)
                  </span>
                )}
                {sub.last_triggered_at && (
                  <span style={{ fontSize: 12, color: "var(--muted)", marginLeft: 8 }}>
                    last triggered {new Date(sub.last_triggered_at).toLocaleString()}
                  </span>
                )}
              </div>
              {testResult?.id === sub.id && (
                <div style={{ fontSize: 12, marginTop: 4, color: testResult.ok ? "#3fb950" : "#e5484d" }}>
                  {testResult.ok ? "Test event delivered successfully" : "Test event failed to deliver"}
                </div>
              )}
            </div>
            <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
              <button type="button" disabled={testMutation.isPending} onClick={() => testMutation.mutate(sub.id)}>
                Send test event
              </button>
              <button
                type="button"
                onClick={() => {
                  if (confirm("Delete this webhook subscription?")) deleteMutation.mutate(sub.id);
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      ))}

      {webhooksQuery.data?.length === 0 && <p style={{ color: "var(--muted)" }}>No webhook subscriptions yet.</p>}
    </div>
  );
}
