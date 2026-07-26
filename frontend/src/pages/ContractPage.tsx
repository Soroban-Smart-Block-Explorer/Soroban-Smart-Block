import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { truncateAddress } from "../utils/strkey";
import EventTable from "../components/EventTable";
import ContractStatsWidget from "../components/ContractStatsWidget";
import RustCodeViewer from "../components/RustCodeViewer";
import MigrationBanner from "../components/MigrationBanner";
import SourceFileTree from "../components/SourceFileTree";
import SimulateButton from "../components/SimulateButton";
import InvocationFlowChart, { type InvocationNode } from "../components/InvocationFlowChart";
import PrivilegedRoles from "../components/PrivilegedRoles";
import SdkSnippet from "../components/SdkSnippet";
import AbiUploadZone from "../components/AbiUploadZone";
import LocalAbiEventTable from "../components/LocalAbiEventTable";
import NetworkComparison from "../components/NetworkComparison";
import AddressConnectionGraph from "../components/AddressConnectionGraph";
import WasmHashZone from "../components/WasmHashZone";
import { useLocalAbi } from "../hooks/useLocalAbi";
import TTLProgressBar from "../components/TTLProgressBar";
import CircuitBreakerStatus from "../components/CircuitBreakerStatus";
import QuorumFreezeBadge from "../components/QuorumFreezeBadge";
import RwaMetadataDisplay from "../components/RwaMetadataDisplay";
import SourceVerificationBadge from "../components/SourceVerificationBadge";
import StateDiffTimeline from "../components/StateDiffTimeline";
import ExportButton from "../components/ExportButton";
import AbiHistoryDrawer from "../components/AbiHistoryDrawer";

type Tab = "overview" | "source" | "simulate" | "flow" | "roles" | "networks" | "graph" | "state-diff" | "abi-history";

function EmptyState({ title, message }: { title: string; message: string }) {
  return (
    <div className="card" style={{ color: "var(--muted)", fontSize: 13 }}>
      <strong style={{ display: "block", color: "var(--text)", fontSize: 14, marginBottom: 6 }}>{title}</strong>
      {message}
    </div>
  );
}

/** Blue checkmark shown next to contract name when DB ABI matches on-chain registry. */
function VerifiedBadge({ ledger }: { ledger?: number | null }) {
  return (
    <span
      title={ledger ? `ABI verified against on-chain registry at ledger #${ledger}` : "ABI verified against on-chain registry"}
      style={{ display: "inline-flex", alignItems: "center", marginLeft: 8, cursor: "default" }}
      aria-label="Verified contract"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <circle cx="8" cy="8" r="8" fill="#1d9bf0" />
        <path d="M4.5 8l2.5 2.5 4.5-5" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

function isInvocationNode(value: unknown): value is InvocationNode {
  if (!value || typeof value !== "object") return false;
  const node = value as Partial<InvocationNode>;
  return typeof node.contract === "string" && node.contract.length > 0 && typeof node.fn === "string" && node.fn.length > 0;
}

/** Compact header badge — mirrors the verification threshold used on the Source tab. */
function VerifiedBadge({ contractId }: { contractId: string }) {
  const MIN_VERIFIED = 3;
  const { data: verifications = [] } = useQuery({
    queryKey: ["source-verifications", contractId],
    queryFn: () => api.sourceVerifications(contractId),
    enabled: !!contractId,
  });
  const isVerified = verifications.length >= MIN_VERIFIED;
  const color = isVerified ? "var(--green, #22c55e)" : "var(--muted)";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 10px",
        borderRadius: 12,
        border: `1px solid ${color}`,
        color,
        fontSize: 11,
        fontWeight: 600,
      }}
      title={isVerified ? `Source verified by ${verifications.length} signatures` : "Source not yet verified"}
    >
      {isVerified ? "✔ Verified" : "✗ Unverified"}
    </span>
  );
}

export default function ContractPage() {
  const { id = "" } = useParams();
  const [tab, setTab] = useState<Tab>("overview");
  const [selectedFn, setSelectedFn] = useState("");
  const [snippetFn, setSnippetFn] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  // ── Local ABI (session-only, never sent to server) ──────────────────────────
  const { localAbi, loadAbi, clearAbi, parseError } = useLocalAbi(id);

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
  const contractEvents = Array.isArray(events) ? events : [];

  const { data: migrationStatus } = useQuery({
    queryKey: ["migration-status", id],
    queryFn: () => api.migrationStatus(id),
    enabled: !!id,
  });

  const { data: abiHistoryData } = useQuery({
    queryKey: ["abi-history", id],
    queryFn: () => api.abiHistory(id),
    enabled: !!id,
  });

  const downloadAbi = () => {
    api.downloadAbi(id).catch((err) => console.error("Download ABI failed:", err));
  };

  const functions = meta?.functions ?? [];
  const sourceFiles = meta?.source_files ?? [];
  const invocationTree = (meta as any)?.invocation_tree;

  // A contract is considered "unverified" when the server has no registered
  // metadata for it (meta is null/404) or it has no functions defined.
  const isUnverified = !meta || functions.length === 0;

  if (metaLoading) return <p style={{ color: "var(--muted)" }}>Loading…</p>;
  if (!meta) {
    // Contract not in the registry — show the upload zone as the primary UI
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <div className="card">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 16,
            }}
          >
            <span
              style={{
                display: "inline-block",
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "var(--yellow)",
                flexShrink: 0,
              }}
            />
            <h2 style={{ fontSize: 16 }}>Not registered — be the first to add ABI metadata</h2>
            <code
              style={{
                fontSize: 12,
                color: "var(--muted)",
                wordBreak: "break-all",
              }}
            >
              {id}
            </code>
          </div>
          <p style={{ color: "var(--muted)", fontSize: 13, marginBottom: 16 }}>
            This contract has no registered ABI. Upload a local spec file to inspect its transaction logs — the file
            stays in your browser session only.
          </p>
          <AbiUploadZone onLoad={loadAbi} onClear={clearAbi} localAbi={localAbi} parseError={parseError} />
        </div>

        {localAbi && (
          <div className="card">
            <h3 style={{ fontSize: 14, marginBottom: 12 }}>Recent Events</h3>
            {evLoading ? (
              <p style={{ color: "var(--muted)" }}>Loading…</p>
            ) : (
              <LocalAbiEventTable events={contractEvents} localAbi={localAbi} />
            )}
          </div>
        )}
      </div>
    );
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: "overview", label: "Overview" },
    { key: "source", label: "Source Code" },
    { key: "simulate", label: "Simulate" },
    { key: "flow", label: "Invocation Flow" },
    { key: "roles", label: "Privileged Roles" },
    { key: "networks", label: "Networks" },
    { key: "graph", label: "Address Graph" },
    { key: "state-diff", label: "State Timeline" },
    { key: "abi-history", label: "ABI History" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* SEP-49 migration pending banner */}
      {migrationStatus?.pending && migrationStatus.upgradedAtLedger != null && (
        <MigrationBanner upgradedAtLedger={migrationStatus.upgradedAtLedger} />
      )}

      {/* Circuit breaker status banner */}
      <CircuitBreakerStatus contractId={id} />

      {/* CAP-0077 quorum freeze security warning */}
      <QuorumFreezeBadge contractId={id} />

      {/* RWA metadata display */}
      <RwaMetadataDisplay contractId={id} />

      {/* Header */}
      <div className="card">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
              <h2 style={{ margin: 0 }}>{meta.name || "Unnamed Contract"}</h2>
              {(meta as any).is_verified && <VerifiedBadge ledger={(meta as any).verified_ledger} />}
              {(meta as any).protocol_type && (meta as any).protocol_type !== "other" && (
                <span
                  style={{
                    marginLeft: 10,
                    fontSize: 11,
                    padding: "2px 8px",
                    borderRadius: 10,
                    background: "var(--border)",
                    color: "var(--muted)",
                    textTransform: "uppercase",
                    fontWeight: 700,
                    letterSpacing: "0.05em",
                  }}
                >
                  {(meta as any).protocol_type}
                </span>
              )}
            </div>
            <p style={{ color: "var(--muted)", marginBottom: 12 }}>
              {meta.description || "No contract description available."}
            </p>
            <code
              style={{
                fontSize: 12,
                color: "var(--muted)",
                wordBreak: "break-all",
                display: "block",
                marginBottom: 8,
              }}
            >
              {id}
            </code>
            <div style={{ display: "flex", gap: 16, fontSize: 12, color: "var(--muted)", flexWrap: "wrap" }}>
              {meta.registered_by && (
                <span>
                  Registered by <code>{truncateAddress(meta.registered_by)}</code>
                </span>
              )}
              {meta.min_ledger != null && <span>Registration ledger: {meta.min_ledger.toLocaleString()}</span>}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={() => setHistoryOpen(true)}
              style={{
                padding: "8px 16px",
                background: "transparent",
                color: "var(--text)",
                border: "1px solid var(--border)",
                borderRadius: 4,
                cursor: "pointer",
                fontSize: 13,
              }}
              aria-label="View ABI version history"
            >
              📜 ABI History
            </button>
            <Link
              to={`/contract/${id}/workspace`}
              style={{
                padding: "8px 16px",
                background: "var(--surface, #1a1a2e)",
                color: "var(--accent)",
                border: "1px solid var(--accent)",
                borderRadius: 4,
                cursor: "pointer",
                fontSize: 13,
                textDecoration: "none",
              }}
            >
              🛠 Dev Workspace
            </Link>
            <button
              onClick={downloadAbi}
              style={{
                padding: "8px 16px",
                background: "var(--accent)",
                color: "#fff",
                border: "none",
                borderRadius: 4,
                cursor: "pointer",
                fontSize: 13,
              }}
            >
              Download ABI
            </button>
          </div>
        </div>

        {meta.dependency_advisory?.outdated && (
          <div
            className="card"
            style={{
              borderLeft: "4px solid #f97316",
              background: "rgba(249, 115, 22, 0.08)",
              color: "#78350f",
              marginTop: 12,
            }}
          >
            <strong>{meta.dependency_advisory.summary}</strong>
            <div
              style={{
                marginTop: 8,
                display: "flex",
                flexWrap: "wrap",
                gap: 12,
                alignItems: "center",
              }}
            >
              {meta.dependency_advisory.packages.map((pkg) => (
                <div key={pkg.name} style={{ minWidth: 180 }}>
                  <div style={{ fontSize: 13 }}>
                    <span style={{ fontWeight: 700 }}>{pkg.name}</span>
                    <span style={{ marginLeft: 6 }}>
                      {pkg.currentVersion} → {pkg.latestVersion}
                    </span>
                  </div>
                  <a href={pkg.upgradeUrl} target="_blank" rel="noreferrer" style={{ color: "#b45309", fontSize: 13 }}>
                    View upgrade guide
                  </a>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Tab bar */}
      <div
        style={{
          display: "flex",
          gap: 4,
          borderBottom: "1px solid var(--border)",
          paddingBottom: 0,
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
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab: Overview */}
      {tab === "overview" && (
        <>
          {/* Contract stats widget — total events, unique callers, last activity, sparkline (#536) */}
          <ContractStatsWidget contractId={id} />

          {/* Local ABI upload zone — shown for unverified contracts or when
              the user wants to override descriptions with a local file */}
          {isUnverified && (
            <div className="card">
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 12,
                }}
              >
                <span
                  style={{
                    display: "inline-block",
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    background: "var(--yellow)",
                    flexShrink: 0,
                  }}
                />
                <h3 style={{ fontSize: 13, color: "var(--yellow)" }}>
                  No registered ABI — upload a local spec to decode events
                </h3>
              </div>
              <AbiUploadZone onLoad={loadAbi} onClear={clearAbi} localAbi={localAbi} parseError={parseError} />
            </div>
          )}

          {/* Collapsible local ABI override for verified contracts */}
          {!isUnverified && (
            <details
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: "10px 16px",
              }}
            >
              <summary
                style={{
                  cursor: "pointer",
                  fontSize: 13,
                  color: localAbi ? "var(--green)" : "var(--muted)",
                  userSelect: "none",
                  listStyle: "none",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                {localAbi ? (
                  <>
                    <span
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: "50%",
                        background: "var(--green)",
                        display: "inline-block",
                        flexShrink: 0,
                      }}
                    />
                    Local ABI active — {localAbi.fileName}
                  </>
                ) : (
                  <>▶ Override event descriptions with a local ABI file</>
                )}
              </summary>
              <div style={{ marginTop: 12 }}>
                <AbiUploadZone onLoad={loadAbi} onClear={clearAbi} localAbi={localAbi} parseError={parseError} />
              </div>
            </details>
          )}

          {/* WASM binary hash calculator */}
          <details
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: "10px 16px",
            }}
          >
            <summary
              style={{
                cursor: "pointer",
                fontSize: 13,
                color: "var(--muted)",
                userSelect: "none",
                listStyle: "none",
              }}
            >
              ▶ Compute WASM deploy hash locally
            </summary>
            <div style={{ marginTop: 12 }}>
              <WasmHashZone />
            </div>
          </details>

          {/* Live TTL expiration progress bars */}
          <TTLProgressBar contractId={id} />

          {/* Invocation frequency (last 30 days) */}
          <InvocationFrequencyChart contractId={id} />

          {/* Storage writes by durability tier */}
          <StorageTierStackedBar contractId={id} />

          {functions.length > 0 ? (
            <div className="card">
              <h3 style={{ marginBottom: 8, fontSize: 14 }}>ABI — Functions</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {functions.map((f) => (
                  <details key={f.name} className="card" style={{ padding: "8px 12px" }}>
                    <summary style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", listStyle: "none" }}>
                      <span className="badge">{f.name}</span>
                      <span style={{ color: "var(--muted)", flex: 1 }}>{f.description}</span>
                      <span style={{ color: "var(--muted)", fontSize: 11 }}>{f.args?.length ?? 0} param(s)</span>
                      {/* SDK snippet copy button */}
                      <button
                        onClick={(e) => {
                          e.preventDefault();
                          setSnippetFn(snippetFn === f.name ? null : f.name);
                        }}
                        style={{
                          padding: "3px 10px",
                          fontSize: 12,
                          background: snippetFn === f.name ? "var(--accent, #7c3aed)" : "var(--bg2, #1e1e2e)",
                          color: snippetFn === f.name ? "#fff" : "var(--muted)",
                          border: "1px solid var(--border, #333)",
                          borderRadius: 4,
                          cursor: "pointer",
                        }}
                      >
                        {"</>"} SDK
                      </button>
                    </summary>
                    <div style={{ marginTop: 10 }}>
                      {f.args && f.args.length > 0 ? (
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                          <thead>
                            <tr style={{ color: "var(--muted)", textAlign: "left" }}>
                              <th style={{ padding: "2px 8px 2px 0" }}>Param</th>
                              <th style={{ padding: "2px 0" }}>Type</th>
                            </tr>
                          </thead>
                          <tbody>
                            {f.args.map((a) => (
                              <tr key={a.name}>
                                <td style={{ padding: "2px 8px 2px 0", fontFamily: "monospace" }}>{a.name}</td>
                                <td style={{ padding: "2px 0", color: "var(--muted)", fontFamily: "monospace" }}>{a.type}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      ) : (
                        <p style={{ color: "var(--muted)", fontSize: 12, margin: 0 }}>No parameters.</p>
                      )}
                    </div>
                    {snippetFn === f.name && <SdkSnippet contractId={id} fnName={f.name} />}
                  </details>
                ))}
              </div>
            </div>
          ) : (
            <EmptyState
              title="No functions available"
              message="This contract did not return ABI function metadata yet."
            />
          )}

          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <h3 style={{ margin: 0 }}>Recent Events</h3>
            <ExportButton target="events" params={{ contract: id }} />
          </div>
          <div className="card">
            {evLoading ? (
              <p style={{ color: "var(--muted)" }}>Loading…</p>
            ) : localAbi ? (
              // Re-render with local ABI descriptions
              <LocalAbiEventTable events={contractEvents} localAbi={localAbi} />
            ) : (
              <EventTable events={contractEvents} />
            )}
          </div>
        </>
      )}

      {/* Tab: Source Code — Issues #45, #85, #135 */}
      {tab === "source" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <SourceVerificationBadge contractId={id} wasmHash={(meta as any).wasm_hash ?? undefined} />
          {sourceFiles.length > 0 ? (
            <SourceFileTree files={sourceFiles} />
          ) : meta.source ? (
            <RustCodeViewer source={meta.source} filename={meta.source_file ?? `${id.slice(0, 8)}.rs`} />
          ) : (
            <EmptyState
              title="No source available"
              message="No verified source files were returned for this contract."
            />
          )}
        </div>
      )}

      {/* Tab: Simulate — */}
      {tab === "simulate" && (
        <div className="card" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <h3 style={{ fontSize: 14 }}>Simulate Contract Call</h3>
          <p style={{ color: "var(--muted)", fontSize: 13 }}>Preview execution results without spending real fees.</p>
          {functions.length > 0 ? (
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <label style={{ color: "var(--muted)" }}>Function:</label>
              <select value={selectedFn} onChange={(e) => setSelectedFn(e.target.value)}>
                <option value="">— select —</option>
                {functions.map((f) => (
                  <option key={f.name} value={f.name}>
                    {f.name}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <p style={{ color: "var(--muted)", fontSize: 13 }}>
              No callable functions were returned for this contract.
            </p>
          )}
          {selectedFn && <SimulateButton contractId={id} fnName={selectedFn} />}
        </div>
      )}

      {/* Tab: Invocation Flow — */}
      {tab === "flow" &&
        (isInvocationNode(invocationTree) ? (
          <InvocationFlowChart root={invocationTree} />
        ) : (
          <EmptyState
            title="No invocation flow available"
            message="No cross-contract invocation trace has been recorded for this contract yet."
          />
        ))}

      {/* Tab: Privileged Roles */}
      {tab === "roles" && <PrivilegedRoles contractId={id} />}

      {/* Tab: Network Comparison — */}
      {tab === "networks" && <NetworkComparison contractId={id} />}

      {/* Tab: Address Connection Graph — */}
      {tab === "graph" && <AddressConnectionGraph contractId={id} />}

      {/* Tab: State-Diff Timeline — */}
      {tab === "state-diff" && <StateDiffTimeline contractId={id} />}

      {/* ABI Version History Drawer — Issue #516 */}
      <AbiHistoryDrawer
        contractId={id}
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
      />
    </div>
  );
}
