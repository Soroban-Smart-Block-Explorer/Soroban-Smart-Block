import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import ThemeToggle from "./ThemeToggle";
import NetworkSwitcher from "./NetworkSwitcher";

export default function Nav() {
  const [q, setQ] = useState("");
  const nav = useNavigate();

  function search(e: React.FormEvent) {
    e.preventDefault();
    const v = q.trim();
    if (!v) return;
    const params = new URLSearchParams({ q: v });
    if (v.startsWith("G") && v.length === 56) params.set("kind", "wallet");
    else if (v.startsWith("M") && v.length === 56) params.set("kind", "wallet");
    else if (v.startsWith("C") && v.length === 56) params.set("kind", "contract");
    nav(`/search?${params}`);
    setQ("");
  }

  return (
    <header
      style={{
        background: "var(--surface)",
        borderBottom: "1px solid var(--border)",
        padding: "12px 24px",
        display: "flex",
        alignItems: "center",
        gap: 16,
      }}
    >
      <Link to="/" style={{ fontWeight: 700, fontSize: 16, whiteSpace: "nowrap" }}>
        ⬡ Soroban Explorer
      </Link>
      <Link to="/contracts" style={{ fontSize: 13, whiteSpace: "nowrap", color: "var(--muted)" }}>
        Registry
      </Link>
      <Link to="/contracts/register" style={{ fontSize: 13, whiteSpace: "nowrap", color: "var(--muted)" }}>
        Register
      </Link>
      <Link to="/search" style={{ fontSize: 13, whiteSpace: "nowrap", color: "var(--muted)" }}>
        Search
      </Link>
      <Link to="/xdr" style={{ fontSize: 13, whiteSpace: "nowrap", color: "var(--muted)" }}>
        XDR Workbench
      </Link>
      <Link to="/rpc-metrics" style={{ fontSize: 13, whiteSpace: "nowrap", color: "var(--muted)" }}>
        RPC Metrics
      </Link>
      <Link to="/graph" style={{ fontSize: 13, whiteSpace: "nowrap", color: "var(--muted)" }}>
        Dep Graph
      </Link>
      <Link to="/sandbox" style={{ fontSize: 13, whiteSpace: "nowrap", color: "var(--muted)" }}>
        Sandbox
      </Link>
      <Link to="/batch" style={{ fontSize: 13, whiteSpace: "nowrap", color: "var(--muted)" }}>
        Batch
      </Link>
      <Link to="/setup" style={{ fontSize: 13, whiteSpace: "nowrap", color: "var(--muted)" }}>
        Setup
      </Link>
      <form onSubmit={search} style={{ display: "flex", gap: 8, flex: 1, maxWidth: 600 }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search contracts, events, wallets…"
          style={{ flex: 1 }}
        />
        <button type="submit">Search</button>
      </form>
      <NetworkSwitcher />
      <ThemeToggle />
    </header>
  );
}
