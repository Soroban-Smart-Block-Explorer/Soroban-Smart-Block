/**
 * Developer Workspace View
 * Unified multi-tab layout: source code, available functions, and transaction history.
 */
import { useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import RustCodeViewer from "../components/RustCodeViewer";
import SourceFileTree from "../components/SourceFileTree";
import EventTable from "../components/EventTable";

type Tab = "source" | "functions" | "history";

const DEMO_SOURCE = `// Verified source not yet uploaded for this contract.
use soroban_sdk::{contract, contractimpl, Env, Address};

#[contract]
pub struct MyContract;

#[contractimpl]
impl MyContract {
    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
    }
}`;

export default function DeveloperWorkspace() {
  const { id = "" } = useParams();
  const [tab, setTab] = useState<Tab>("source");

  const { data: meta, isLoading: metaLoading } = useQuery({
    queryKey: ["contract", id],
    queryFn: () => api.contract(id),
    enabled: !!id,
  });

  const { data: events = [], isLoading: evLoading } = useQuery({
    queryKey: ["events", id],
    queryFn: () => api.events({ contract: id }).then((page) => page.data),
    enabled: !!id,
  });

  if (metaLoading) return <p style={{ color: "var(--muted)" }}>Loading…</p>;
  if (!meta) return <p>Contract not found.</p>;

  const tabs: { key: Tab; label: string }[] = [
    { key: "source", label: "📄 Source Code" },
    { key: "functions", label: "⚙ Functions" },
    { key: "history", label: "📋 Tx History" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Header */}
      <div className="card">
        <h2 style={{ marginBottom: 4 }}>Developer Workspace</h2>
        <p style={{ color: "var(--muted)", fontSize: 13, marginBottom: 4 }}>{meta.name}</p>
        <code
          style={{
            fontSize: 11,
            color: "var(--muted)",
            wordBreak: "break-all",
          }}
        >
          {id}
        </code>
      </div>

      {/* Tab bar */}
      <div
        style={{
          display: "flex",
          gap: 4,
          borderBottom: "1px solid var(--border)",
        }}
      >
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              background: "none",
              color: tab === t.key ? "var(--accent)" : "var(--muted)",
              borderBottom: tab === t.key ? "2px solid var(--accent)" : "2px solid transparent",
              borderRadius: 0,
              padding: "8px 16px",
              fontWeight: tab === t.key ? 700 : 400,
              cursor: "pointer",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab: Source Code */}
      {tab === "source" &&
        (meta.source_files && meta.source_files.length > 0 ? (
          <SourceFileTree files={meta.source_files} />
        ) : (
          <RustCodeViewer source={meta.source ?? DEMO_SOURCE} filename={meta.source_file ?? `${id.slice(0, 8)}.rs`} />
        ))}

      {/* Tab: Functions */}
      {tab === "functions" && (
        <div className="card">
          {meta.functions.length === 0 ? (
            <p style={{ color: "var(--muted)" }}>No functions registered for this contract.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {meta.functions.map((f) => (
                <div
                  key={f.name}
                  className="card"
                  style={{
                    padding: "12px 16px",
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 12,
                  }}
                >
                  <span className="badge" style={{ flexShrink: 0 }}>
                    {f.name}
                  </span>
                  <span style={{ color: "var(--muted)", fontSize: 13 }}>{f.description || "No description."}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Tab: Transaction History */}
      {tab === "history" && (
        <div className="card">
          {evLoading ? <p style={{ color: "var(--muted)" }}>Loading…</p> : <EventTable events={events} />}
        </div>
      )}
    </div>
  );
}
