/**
 * Public status page (issue #758).
 * Shows current service health (from /api/health) and rolling uptime
 * history (from /api/status/history), backed by uptimeRecorder.js samples.
 */
import { useEffect, useState } from "react";

interface HealthResponse {
  status: "healthy" | "degraded" | "unhealthy";
  timestamp: string;
  dependencies: {
    database: { status: string };
    cache: { status: string };
    indexer: { status: string; lagSeconds?: number };
    workers: { status: string };
  };
}

interface UptimeDay {
  date: string;
  uptime_pct: number | null;
}

const STATUS_COLOR: Record<string, string> = {
  healthy: "#16a34a",
  degraded: "#d97706",
  unhealthy: "#dc2626",
  alive: "#16a34a",
};

function dayColor(pct: number | null): string {
  if (pct === null) return "#e5e7eb";
  if (pct >= 99.9) return "#16a34a";
  if (pct >= 95) return "#d97706";
  return "#dc2626";
}

export default function Status() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [history, setHistory] = useState<UptimeDay[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [healthRes, historyRes] = await Promise.all([fetch("/api/health"), fetch("/api/status/history?days=30")]);
        const healthData = await healthRes.json();
        const historyData = await historyRes.json();
        if (!cancelled) {
          setHealth(healthData);
          setHistory(historyData.history || []);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load status");
      }
    }

    load();
    const interval = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const overallPct =
    history.length > 0
      ? Math.round((history.reduce((sum, d) => sum + (d.uptime_pct ?? 100), 0) / history.length) * 100) / 100
      : null;

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "24px 0" }}>
      <h1 style={{ marginBottom: 4 }}>Soroban Explorer Status</h1>
      <p style={{ color: "#6b7280", marginBottom: 24 }}>Live service health and 30-day uptime history.</p>

      {error && <p style={{ color: "#dc2626" }}>{error}</p>}

      {health && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "12px 16px",
            borderRadius: 8,
            background: "#f9fafb",
            marginBottom: 24,
          }}
        >
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              background: STATUS_COLOR[health.status] || "#6b7280",
              display: "inline-block",
            }}
          />
          <strong style={{ textTransform: "capitalize" }}>{health.status}</strong>
          <span style={{ color: "#9ca3af", fontSize: 13 }}>as of {new Date(health.timestamp).toLocaleString()}</span>
        </div>
      )}

      {health && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12, marginBottom: 24 }}>
          {Object.entries(health.dependencies).map(([name, dep]) => (
            <div key={name} style={{ background: "#f9fafb", borderRadius: 6, padding: "10px 12px" }}>
              <div style={{ fontSize: 11, color: "#9ca3af", textTransform: "uppercase", marginBottom: 4 }}>{name}</div>
              <div style={{ fontSize: 14, fontWeight: 600, color: STATUS_COLOR[dep.status] || "#111827", textTransform: "capitalize" }}>
                {dep.status}
              </div>
            </div>
          ))}
        </div>
      )}

      <h2 style={{ fontSize: 15, marginBottom: 8 }}>
        30-day uptime{overallPct !== null ? ` — ${overallPct}% average` : ""}
      </h2>
      <div style={{ display: "flex", gap: 2 }}>
        {history.map((day) => (
          <div
            key={day.date}
            title={`${day.date}: ${day.uptime_pct !== null ? `${day.uptime_pct}%` : "no data"}`}
            style={{
              flex: 1,
              height: 32,
              borderRadius: 2,
              background: dayColor(day.uptime_pct),
            }}
          />
        ))}
      </div>
      {history.length === 0 && !error && <p style={{ color: "#9ca3af", fontSize: 13 }}>No uptime samples recorded yet.</p>}
    </div>
  );
}
