import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { dashboardApi } from "../../services/dashboardApi";

export default function WebhookDeliveriesPanel() {
  const queryClient = useQueryClient();
  const [webhookId, setWebhookId] = useState("");
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<number | null>(null);

  const webhooksQuery = useQuery({ queryKey: ["webhooks"], queryFn: dashboardApi.listWebhooks });

  const deliveriesQuery = useQuery({
    queryKey: ["webhook-deliveries", webhookId, page],
    queryFn: () => dashboardApi.listDeliveries(webhookId, page),
    enabled: !!webhookId,
  });

  const retryMutation = useMutation({
    mutationFn: (deliveryId: number) => dashboardApi.retryDelivery(webhookId, deliveryId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["webhook-deliveries", webhookId] }),
  });

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <select
          value={webhookId}
          onChange={(e) => {
            setWebhookId(e.target.value);
            setPage(1);
          }}
        >
          <option value="">Select a webhook subscription…</option>
          {webhooksQuery.data?.map((sub) => (
            <option key={sub.id} value={sub.id}>
              {sub.url}
            </option>
          ))}
        </select>
      </div>

      {!webhookId && <p style={{ color: "var(--muted)" }}>Pick a subscription above to see its delivery log.</p>}

      {deliveriesQuery.isLoading && <p style={{ color: "var(--muted)" }}>Loading deliveries…</p>}
      {deliveriesQuery.isError && (
        <p style={{ color: "#e5484d" }} role="alert">
          {(deliveriesQuery.error as Error).message}
        </p>
      )}

      {deliveriesQuery.data?.data.map((d) => {
        const success = !!d.delivered_at;
        return (
          <div key={d.id} className="card" style={{ padding: 12, marginBottom: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <div>
                <span className="badge" style={{ color: success ? "#3fb950" : "#e5484d" }}>
                  {success ? "success" : "failed"}
                </span>{" "}
                <span style={{ fontSize: 12, color: "var(--muted)" }}>
                  {d.response_status ?? "no response"} · {d.duration_ms ?? "?"}ms ·{" "}
                  {new Date(d.created_at).toLocaleString()}
                  {d.event_seq != null && ` · event #${d.event_seq}`}
                </span>
              </div>
              <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                <button type="button" onClick={() => setExpanded(expanded === d.id ? null : d.id)}>
                  {expanded === d.id ? "Hide response" : "View response"}
                </button>
                {!success && (
                  <button type="button" disabled={retryMutation.isPending} onClick={() => retryMutation.mutate(d.id)}>
                    Retry
                  </button>
                )}
              </div>
            </div>
            {expanded === d.id && (
              <pre
                style={{
                  marginTop: 8,
                  padding: 8,
                  background: "var(--border)",
                  borderRadius: 4,
                  fontSize: 12,
                  overflowX: "auto",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {d.response_body || "(empty response body)"}
              </pre>
            )}
          </div>
        );
      })}

      {deliveriesQuery.data && deliveriesQuery.data.data.length === 0 && (
        <p style={{ color: "var(--muted)" }}>No deliveries yet.</p>
      )}

      {deliveriesQuery.data && deliveriesQuery.data.pagination.total_pages > 1 && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
          <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Previous
          </button>
          <span style={{ fontSize: 12, color: "var(--muted)" }}>
            page {deliveriesQuery.data.pagination.page} of {deliveriesQuery.data.pagination.total_pages}
          </span>
          <button
            type="button"
            disabled={page >= deliveriesQuery.data.pagination.total_pages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
