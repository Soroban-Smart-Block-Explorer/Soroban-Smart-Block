/**
 * Rate Limit Analytics Dashboard
 * Polls analytics endpoints every 5 seconds. Requires admin authentication.
 */
import { useEffect, useState, useCallback } from "react";
import RateLimitHitsChart from "../components/RateLimitHitsChart";
import TopUsersTable from "../components/TopUsersTable";
import ViolationHeatmap from "../components/ViolationHeatmap";
import UpgradeRecommendations from "../components/UpgradeRecommendations";

type Window = "1h" | "24h" | "7d";

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        border: "1px solid #e5e7eb",
        borderRadius: 8,
        padding: 20,
        background: "#fff",
        marginBottom: 20,
      }}
    >
      <h3 style={{ margin: "0 0 16px", fontSize: 15, fontWeight: 600, color: "#111827" }}>
        {title}
      </h3>
      {children}
    </div>
  );
}

export default function RateLimitDashboard() {
  const [adminToken, setAdminToken] = useState(() => sessionStorage.getItem("admin_token") ?? "");
  const [adminTotp, setAdminTotp] = useState(() => sessionStorage.getItem("admin_totp") ?? "");
  const [tokenInput, setTokenInput] = useState(() => sessionStorage.getItem("admin_token") ?? "");
  const [totpInput, setTotpInput] = useState("");
  const [authed, setAuthed] = useState(false);

  const [hitsData, setHitsData] = useState([]);
  const [topUsers, setTopUsers] = useState([]);
  const [heatmap, setHeatmap] = useState([]);
  const [recommendations, setRecommendations] = useState([]);
  const [topWindow, setTopWindow] = useState<Window>("24h");
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  const buildHeaders = useCallback((): HeadersInit => {
    const headers: Record<string, string> = { Authorization: `Bearer ${adminToken}` };
    if (adminTotp) {
      headers["X-Admin-TOTP"] = adminTotp;
    }
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

  const fetchAll = useCallback(async () => {
    if (!adminToken) return;
    try {
      const headers = buildHeaders();
      const [hitsRes, topRes, heatmapRes, recsRes] = await Promise.all([
        fetch("/api/admin/analytics/rate-limit-hits?minutes=60", { headers }),
        fetch(`/api/admin/analytics/top-users?window=${topWindow}`, { headers }),
        fetch("/api/admin/analytics/violation-heatmap", { headers }),
        fetch("/api/admin/analytics/upgrade-recommendations", { headers }),
      ]);

      if (hitsRes.status === 401) {
        setAuthed(false);
        let body: { totp_required?: boolean } = {};
        try {
          body = await hitsRes.json();
        } catch {
          /* ignore */
        }
        if (body.totp_required) {
          sessionStorage.removeItem("admin_totp");
          setAdminTotp("");
          setError("Enter a current authenticator (TOTP) code to continue.");
        } else {
          setError("Invalid or expired admin token.");
        }
        return;
      }

      setHitsData(await hitsRes.json());
      setTopUsers(await topRes.json());
      setHeatmap(await heatmapRes.json());
      setRecommendations(await recsRes.json());
      setLastUpdated(new Date());
      setAuthed(true);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    }
  }, [adminToken, topWindow, buildHeaders]);

  useEffect(() => {
    if (!adminToken) return;
    fetchAll();
    const id = setInterval(fetchAll, 5_000);
    return () => clearInterval(id);
  }, [fetchAll]);

  // Re-fetch top users when window changes
  useEffect(() => {
    if (!authed) return;
    fetch(`/api/admin/analytics/top-users?window=${topWindow}`, { headers: buildHeaders() })
      .then((r) => r.json())
      .then(setTopUsers)
      .catch(() => {});
  }, [topWindow, authed, buildHeaders]);

  // Login screen
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
          Enter your ADMIN_SECRET to access the Rate Limit Dashboard. If admin 2FA is
          enabled, also enter a current authenticator code.
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
          onKeyDown={(e) => {
            if (e.key === "Enter") signIn();
          }}
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
          onKeyDown={(e) => {
            if (e.key === "Enter") signIn();
          }}
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

  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 24,
        }}
      >
        <h2 style={{ margin: 0 }}>Rate Limit Analytics</h2>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          {lastUpdated && (
            <span style={{ fontSize: 12, color: "#9ca3af" }}>
              Updated {lastUpdated.toLocaleTimeString()}
            </span>
          )}
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

      <Card title="Rate Limit Hits / Minute (last 60 min)">
        <RateLimitHitsChart data={hitsData} />
      </Card>

      <Card title="Top Users by Request Volume">
        <TopUsersTable data={topUsers} window={topWindow} onWindowChange={setTopWindow} />
      </Card>

      <Card title="Violation Heat Map (last 30 days)">
        <ViolationHeatmap data={heatmap} />
      </Card>

      <Card title="Tier Upgrade Recommendations">
        <UpgradeRecommendations data={recommendations} />
      </Card>
    </div>
  );
}
