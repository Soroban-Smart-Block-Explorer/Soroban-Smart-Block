/**
 * Admin Audit Trail
 * Views and filters `api_audit_log` via GET /api/admin/audit-log, and
 * exports via GET /api/admin/audit-log/export. Requires admin authentication.
 */
import { useEffect, useState, useCallback } from "react";

type AuditLogRow = {
  id: number | string;
  timestamp: string;
  api_key_id: string | null;
  key_name: string | null;
  tier: string | null;
  ip: string | null;
  method: string;
  endpoint: string;
  status_code: number;
  response_time_ms: number | null;
  rate_limit_remaining: number | null;
  user_agent: string | null;
  request_body_hash: string | null;
};

type Filters = {
  api_key_id: string;
  ip: string;
  endpoint: string;
  status_code: string;
  from: string;
  to: string;
};

const EMPTY_FILTERS: Filters = { api_key_id: "", ip: "", endpoint: "", status_code: "", from: "", to: "" };

function buildQuery(filters: Filters, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value.trim()) params.set(key, value.trim());
  });
  Object.entries(extra).forEach(([key, value]) => params.set(key, value));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export default function AuditLogPage() {
  const [adminToken, setAdminToken] = useState(() => sessionStorage.getItem("admin_token") ?? "");
  const [adminTotp, setAdminTotp] = useState(() => sessionStorage.getItem("admin_totp") ?? "");
  const [tokenInput, setTokenInput] = useState(() => sessionStorage.getItem("admin_token") ?? "");
  const [totpInput, setTotpInput] = useState("");
  const [authed, setAuthed] = useState(false);

  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [rows, setRows] = useState<AuditLogRow[]>([]);
  const [offset, setOffset] = useState(0);
  const [limit] = useState(100);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const buildHeaders = useCallback((): HeadersInit => {
    const headers: Record<string, string> = { Authorization: `Bearer ${adminToken}` };
    if (adminTotp) headers["X-Admin-TOTP"] = adminTotp;
    return headers;
  }, [adminToken, adminTotp]);

  const signIn = () => {
    const token = tokenInput.trim() || adminToken;
    if (!token) {
      setError("Admin token is required.");
      return;
    }
    sessionStorage.setItem("admin_token", token);
    setAdminToken(token);
    setTokenInput(token);
    if (totpInput.trim()) {
      sessionStorage.setItem("admin_totp", totpInput.trim());
      setAdminTotp(totpInput.trim());
    } else {
      sessionStorage.removeItem("admin_totp");
      setAdminTotp("");
    }
  };

  const signOut = () => {
    sessionStorage.removeItem("admin_token");
    sessionStorage.removeItem("admin_totp");
    setAdminToken("");
    setAdminTotp("");
    setTotpInput("");
    setAuthed(false);
  };

  const fetchLog = useCallback(
    async (nextOffset = 0) => {
      if (!adminToken) return;
      setLoading(true);
      try {
        const res = await fetch(
          `/api/admin/audit-log${buildQuery(filters, { limit: String(limit), offset: String(nextOffset) })}`,
          { headers: buildHeaders() },
        );
        if (res.status === 401) {
          setAuthed(false);
          setError("Invalid or expired admin token.");
          return;
        }
        const body = await res.json();
        setRows(body.data ?? []);
        setOffset(nextOffset);
        setAuthed(true);
        setError(null);
      } catch (e: any) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    },
    [adminToken, filters, limit, buildHeaders],
  );

  useEffect(() => {
    if (!adminToken) return;
    fetchLog(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminToken]);

  const exportLog = (format: "csv" | "json") => {
    const url = `/api/admin/audit-log/export${buildQuery(filters, { format })}`;
    fetch(url, { headers: buildHeaders() })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Export failed (${res.status})`);
        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = objectUrl;
        a.download = `audit-log.${format}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(objectUrl);
      })
      .catch((e) => setError(e.message));
  };

  if (!adminToken || !authed) {
    return (
      <div
        style={{
          maxWidth: 400,
          margin: "80px auto",
          border: "1px solid #e5e7eb",
          borderRadius: 8,
          padding: 32,
          background: "#fff",
        }}
      >
        <h2 style={{ margin: "0 0 8px", fontSize: 18 }}>Admin Login</h2>
        <p style={{ color: "#6b7280", fontSize: 13, marginBottom: 20 }}>
          Enter your ADMIN_SECRET to access the Audit Trail. If admin 2FA is enabled, also
          enter a current authenticator code.
        </p>
        {error && (
          <div
            style={{
              padding: "8px 12px",
              background: "#fee2e2",
              borderRadius: 4,
              color: "#991b1b",
              fontSize: 13,
              marginBottom: 12,
            }}
          >
            {error}
          </div>
        )}
        <input
          type="password"
          placeholder="Admin token"
          value={tokenInput}
          onChange={(e) => setTokenInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && signIn()}
          style={{
            width: "100%",
            padding: "8px 12px",
            borderRadius: 4,
            border: "1px solid #d1d5db",
            fontSize: 14,
            boxSizing: "border-box",
            marginBottom: 12,
          }}
          aria-label="Admin token"
        />
        <input
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="TOTP code (if 2FA enabled)"
          value={totpInput}
          onChange={(e) => setTotpInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && signIn()}
          style={{
            width: "100%",
            padding: "8px 12px",
            borderRadius: 4,
            border: "1px solid #d1d5db",
            fontSize: 14,
            boxSizing: "border-box",
            marginBottom: 12,
          }}
          aria-label="TOTP code"
        />
        <button
          onClick={signIn}
          style={{
            width: "100%",
            padding: "8px 12px",
            background: "#7c3aed",
            color: "#fff",
            border: "none",
            borderRadius: 4,
            fontSize: 14,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Sign in
        </button>
      </div>
    );
  }

  const inputStyle: React.CSSProperties = {
    padding: "6px 10px",
    borderRadius: 4,
    border: "1px solid #d1d5db",
    fontSize: 13,
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Audit Trail</h2>
        <button
          onClick={signOut}
          style={{
            padding: "4px 12px",
            fontSize: 12,
            borderRadius: 4,
            border: "1px solid #e5e7eb",
            background: "#f9fafb",
            cursor: "pointer",
          }}
        >
          Sign out
        </button>
      </div>

      {error && (
        <div
          style={{
            padding: 12,
            background: "#fee2e2",
            borderRadius: 6,
            marginBottom: 16,
            color: "#991b1b",
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          marginBottom: 16,
          padding: 16,
          border: "1px solid #e5e7eb",
          borderRadius: 8,
          background: "#fff",
        }}
      >
        <input
          style={inputStyle}
          placeholder="API key ID"
          value={filters.api_key_id}
          onChange={(e) => setFilters({ ...filters, api_key_id: e.target.value })}
        />
        <input
          style={inputStyle}
          placeholder="IP"
          value={filters.ip}
          onChange={(e) => setFilters({ ...filters, ip: e.target.value })}
        />
        <input
          style={inputStyle}
          placeholder="Endpoint"
          value={filters.endpoint}
          onChange={(e) => setFilters({ ...filters, endpoint: e.target.value })}
        />
        <input
          style={inputStyle}
          placeholder="Status code"
          value={filters.status_code}
          onChange={(e) => setFilters({ ...filters, status_code: e.target.value })}
        />
        <input
          style={inputStyle}
          type="datetime-local"
          value={filters.from}
          onChange={(e) => setFilters({ ...filters, from: e.target.value })}
        />
        <input
          style={inputStyle}
          type="datetime-local"
          value={filters.to}
          onChange={(e) => setFilters({ ...filters, to: e.target.value })}
        />
        <button style={inputStyle} onClick={() => fetchLog(0)} disabled={loading}>
          {loading ? "Loading…" : "Apply filters"}
        </button>
        <button
          style={inputStyle}
          onClick={() => {
            setFilters(EMPTY_FILTERS);
          }}
        >
          Reset
        </button>
        <span style={{ flex: 1 }} />
        <button style={inputStyle} onClick={() => exportLog("csv")}>
          Export CSV
        </button>
        <button style={inputStyle} onClick={() => exportLog("json")}>
          Export JSON
        </button>
      </div>

      <div style={{ overflowX: "auto", border: "1px solid #e5e7eb", borderRadius: 8, background: "#fff" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>
              {["Timestamp", "Key", "Tier", "IP", "Method", "Endpoint", "Status", "Latency", "Body Hash"].map(
                (h) => (
                  <th key={h} style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
                <td style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>
                  {new Date(row.timestamp).toLocaleString()}
                </td>
                <td style={{ padding: "8px 12px" }}>{row.key_name ?? "—"}</td>
                <td style={{ padding: "8px 12px" }}>{row.tier ?? "—"}</td>
                <td style={{ padding: "8px 12px" }}>{row.ip ?? "—"}</td>
                <td style={{ padding: "8px 12px" }}>{row.method}</td>
                <td style={{ padding: "8px 12px" }}>{row.endpoint}</td>
                <td style={{ padding: "8px 12px" }}>{row.status_code}</td>
                <td style={{ padding: "8px 12px" }}>
                  {row.response_time_ms != null ? `${row.response_time_ms}ms` : "—"}
                </td>
                <td style={{ padding: "8px 12px", fontFamily: "monospace", fontSize: 11 }}>
                  {row.request_body_hash ?? "—"}
                </td>
              </tr>
            ))}
            {rows.length === 0 && !loading && (
              <tr>
                <td colSpan={9} style={{ padding: 16, textAlign: "center", color: "#9ca3af" }}>
                  No audit log entries match the current filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
        <button style={inputStyle} onClick={() => fetchLog(Math.max(0, offset - limit))} disabled={offset === 0}>
          Previous
        </button>
        <button
          style={inputStyle}
          onClick={() => fetchLog(offset + limit)}
          disabled={rows.length < limit}
        >
          Next
        </button>
      </div>
    </div>
  );
}
