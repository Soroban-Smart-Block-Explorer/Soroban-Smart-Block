import { useEffect, useState } from "react";

// Registry moderation queue (#934): review held/pending/reported/appealed
// registrations with their risk evidence, and approve, reject, hide or ban.

type QueueItem = {
  id: string;
  name: string | null;
  description: string | null;
  registered_by: string | null;
  moderation_status: string;
  risk_score: number;
  risk_signals: { signal: string; points: number; detail?: string }[];
  open_reports: number;
  report_weight: number;
  open_appeals: number;
};
type Appeal = { id: number; submitter: string; message: string; status: string; created_at: string };
type Report = { id: number; reporter: string; reason: string; details: string | null; weight: number; resolved: boolean };
type Action = { id: number; action: string; actor: string; to_status: string | null; notice: string | null; created_at: string };
type Detail = { contract: QueueItem; reports: Report[]; actions: Action[]; appeals: Appeal[] };

const VIEWS = ["held", "pending", "reported", "appealed", "hidden", "rejected"] as const;
const ACTIONS = ["approve", "reject", "hide", "ban"] as const;

export default function AdminModerationPage() {
  const [view, setView] = useState<(typeof VIEWS)[number]>("held");
  const [items, setItems] = useState<QueueItem[]>([]);
  const [templates, setTemplates] = useState<Record<string, string>>({});
  const [detail, setDetail] = useState<Detail | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");

  const load = async () => {
    try {
      const res = await fetch(`/api/admin/moderation/queue?status=${view}`);
      if (!res.ok) throw new Error("Unable to load moderation queue");
      const data = await res.json();
      setItems(data.items ?? []);
      setTemplates(data.templates ?? {});
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load moderation queue");
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  const open = async (id: string) => {
    const res = await fetch(`/api/admin/moderation/contracts/${encodeURIComponent(id)}`);
    if (res.ok) setDetail(await res.json());
  };

  const act = async (action: (typeof ACTIONS)[number]) => {
    if (!detail) return;
    const res = await fetch(`/api/admin/moderation/contracts/${encodeURIComponent(detail.contract.id)}/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, reason: reason || undefined }),
    });
    if (!res.ok) return setError((await res.json().catch(() => ({}))).error ?? "Action failed");
    setReason("");
    await open(detail.contract.id);
    await load();
  };

  const decide = async (appealId: number, granted: boolean) => {
    await fetch(`/api/admin/moderation/appeals/${appealId}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ granted }),
    });
    if (detail) await open(detail.contract.id);
    await load();
  };

  return (
    <section aria-labelledby="moderation-heading">
      <div className="page-header">
        <div>
          <h1 id="moderation-heading">Registry moderation</h1>
          <p>Curates registry metadata only — on-chain events are never hidden.</p>
        </div>
        <button type="button" onClick={load}>Refresh</button>
      </div>
      <div role="tablist" aria-label="Moderation queues" style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        {VIEWS.map((v) => (
          <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => setView(v)}>
            {v}
          </button>
        ))}
      </div>
      {error && <p role="alert">{error}</p>}
      <div className="card">
        <table aria-label="Moderation queue">
          <thead>
            <tr><th>Contract</th><th>Status</th><th>Risk</th><th>Reports</th><th>Appeals</th><th /></tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>{item.name ?? item.id}</td>
                <td>{item.moderation_status}</td>
                <td>{item.risk_score}</td>
                <td>{item.open_reports} (weight {Number(item.report_weight).toFixed(1)})</td>
                <td>{item.open_appeals}</td>
                <td><button type="button" onClick={() => open(item.id)}>Review</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {items.length === 0 && <p>Queue is empty.</p>}
      </div>

      {detail && (
        <div className="card" aria-label="Moderation detail" style={{ marginTop: 16 }}>
          <h2>{detail.contract.name ?? detail.contract.id}</h2>
          <p><code>{detail.contract.id}</code> — status <strong>{detail.contract.moderation_status}</strong>, risk {detail.contract.risk_score}</p>
          <p>{detail.contract.description}</p>
          <h3>Evidence</h3>
          <ul>
            {detail.contract.risk_signals.map((s, i) => (
              <li key={i}>{s.signal} (+{s.points}){s.detail ? `: ${s.detail}` : ""}</li>
            ))}
            {detail.reports.map((r) => (
              <li key={`r${r.id}`}>Report by {r.reporter}: {r.reason} (weight {r.weight.toFixed(1)}){r.details ? ` — ${r.details}` : ""}{r.resolved ? " [resolved]" : ""}</li>
            ))}
          </ul>
          <label>
            Reason (fills the notice template)
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. impersonates USDC" />
          </label>
          <div style={{ display: "flex", gap: 8, margin: "8px 0" }}>
            {ACTIONS.map((a) => (
              <button key={a} type="button" onClick={() => act(a)} title={templates[a]}>{a}</button>
            ))}
          </div>
          {detail.appeals.length > 0 && (
            <>
              <h3>Appeals</h3>
              <ul>
                {detail.appeals.map((ap) => (
                  <li key={ap.id}>
                    {ap.submitter}: {ap.message} — {ap.status}
                    {ap.status === "open" && (
                      <>
                        {" "}<button type="button" onClick={() => decide(ap.id, true)}>Grant</button>
                        {" "}<button type="button" onClick={() => decide(ap.id, false)}>Deny</button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          <h3>Audit log</h3>
          <ul>
            {detail.actions.map((a) => (
              <li key={a.id}>{new Date(a.created_at).toLocaleString()} — {a.action} by {a.actor}{a.to_status ? ` → ${a.to_status}` : ""}{a.notice ? ` (“${a.notice}”)` : ""}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
