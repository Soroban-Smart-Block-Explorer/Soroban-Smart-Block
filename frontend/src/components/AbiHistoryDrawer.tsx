/**
 * AbiHistoryDrawer — Issue #516
 *
 * Slide-in drawer showing the ABI version history for a contract.
 * Fetches GET /api/contracts/:id/abi-history and shows each version
 * with a diff view: added functions (green), removed (red), changed params (yellow).
 */
import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type AbiVersionEntry } from "../api";

interface FnDef {
  name: string;
  description?: string;
  params?: { name: string; kind: string }[];
}

type DiffStatus = "added" | "removed" | "changed" | "unchanged";

interface FnDiff {
  name: string;
  status: DiffStatus;
  prev: FnDef | null;
  next: FnDef | null;
}

function diffFunctions(prev: FnDef[] | null, next: FnDef[] | null): FnDiff[] {
  const prevMap = new Map<string, FnDef>((prev ?? []).map((f) => [f.name, f]));
  const nextMap = new Map<string, FnDef>((next ?? []).map((f) => [f.name, f]));

  const result: FnDiff[] = [];

  // Functions in prev
  for (const [name, prevFn] of prevMap) {
    if (nextMap.has(name)) {
      const nextFn = nextMap.get(name)!;
      const prevParams = JSON.stringify(prevFn.params ?? []);
      const nextParams = JSON.stringify(nextFn.params ?? []);
      result.push({
        name,
        status: prevParams !== nextParams ? "changed" : "unchanged",
        prev: prevFn,
        next: nextFn,
      });
    } else {
      result.push({ name, status: "removed", prev: prevFn, next: null });
    }
  }

  // Added functions (in next but not prev)
  for (const [name, nextFn] of nextMap) {
    if (!prevMap.has(name)) {
      result.push({ name, status: "added", prev: null, next: nextFn });
    }
  }

  return result;
}

const STATUS_COLORS: Record<DiffStatus, string> = {
  added: "#1a7f37",
  removed: "#a40e26",
  changed: "#9a6700",
  unchanged: "var(--muted)",
};

const STATUS_LABELS: Record<DiffStatus, string> = {
  added: "+ added",
  removed: "− removed",
  changed: "~ changed",
  unchanged: "",
};

function ParamPill({ name, kind }: { name: string; kind: string }) {
  return (
    <code
      style={{
        fontSize: 11,
        background: "var(--border)",
        borderRadius: 3,
        padding: "1px 5px",
        marginRight: 4,
      }}
    >
      {name}: {kind}
    </code>
  );
}

function VersionCard({
  entry,
  prev,
}: {
  entry: AbiVersionEntry;
  prev: AbiVersionEntry | null;
}) {
  const diffs = diffFunctions(
    prev?.functions ?? null,
    entry.functions ?? null,
  );
  const showDiff = prev !== null && diffs.some((d) => d.status !== "unchanged");
  const isFirst = prev === null;

  return (
    <div
      style={{
        borderBottom: "1px solid var(--border)",
        padding: "14px 0",
      }}
    >
      {/* Version header */}
      <div style={{ display: "flex", gap: 10, alignItems: "baseline", marginBottom: 4 }}>
        <strong style={{ fontSize: 14 }}>v{entry.abi_version}</strong>
        <span style={{ fontSize: 12, color: "var(--muted)" }}>
          Ledger #{entry.min_ledger}
        </span>
        <span style={{ fontSize: 12, color: "var(--muted)" }}>
          {new Date(entry.created_at).toLocaleString()}
        </span>
        {isFirst && (
          <span
            style={{
              fontSize: 11,
              padding: "1px 6px",
              border: "1px solid var(--border)",
              borderRadius: 10,
              color: "var(--muted)",
            }}
          >
            initial
          </span>
        )}
      </div>

      {/* If first version: just show function list */}
      {isFirst && (
        <div style={{ marginTop: 8 }}>
          {(entry.functions ?? []).map((fn) => (
            <div key={fn.name} style={{ marginBottom: 6 }}>
              <code style={{ fontSize: 13, fontWeight: 600 }}>{fn.name}</code>
              {fn.params && fn.params.length > 0 && (
                <div style={{ marginTop: 2 }}>
                  {fn.params.map((p) => (
                    <ParamPill key={p.name} name={p.name} kind={p.kind} />
                  ))}
                </div>
              )}
            </div>
          ))}
          {(entry.functions ?? []).length === 0 && (
            <p style={{ fontSize: 12, color: "var(--muted)" }}>No functions defined.</p>
          )}
        </div>
      )}

      {/* Diff view for subsequent versions */}
      {!isFirst && showDiff && (
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
          {diffs
            .filter((d) => d.status !== "unchanged")
            .map((d) => (
              <div
                key={d.name}
                style={{
                  borderLeft: `3px solid ${STATUS_COLORS[d.status]}`,
                  paddingLeft: 10,
                }}
              >
                <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                  <code style={{ fontSize: 13, fontWeight: 600 }}>{d.name}</code>
                  <span
                    style={{
                      fontSize: 11,
                      color: STATUS_COLORS[d.status],
                      fontWeight: 600,
                    }}
                  >
                    {STATUS_LABELS[d.status]}
                  </span>
                </div>
                {d.status === "added" && d.next?.params && (
                  <div style={{ marginTop: 2 }}>
                    {d.next.params.map((p) => (
                      <ParamPill key={p.name} name={p.name} kind={p.kind} />
                    ))}
                  </div>
                )}
                {d.status === "changed" && (
                  <div style={{ marginTop: 4 }}>
                    {d.prev?.params && d.prev.params.length > 0 && (
                      <div style={{ marginBottom: 2 }}>
                        <span style={{ fontSize: 11, color: STATUS_COLORS.removed, marginRight: 4 }}>
                          before:
                        </span>
                        {d.prev.params.map((p) => (
                          <ParamPill key={p.name} name={p.name} kind={p.kind} />
                        ))}
                      </div>
                    )}
                    {d.next?.params && d.next.params.length > 0 && (
                      <div>
                        <span style={{ fontSize: 11, color: STATUS_COLORS.added, marginRight: 4 }}>
                          after:
                        </span>
                        {d.next.params.map((p) => (
                          <ParamPill key={p.name} name={p.name} kind={p.kind} />
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
        </div>
      )}

      {/* No meaningful changes */}
      {!isFirst && !showDiff && (
        <p style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>
          No function changes in this version.
        </p>
      )}
    </div>
  );
}

interface Props {
  contractId: string;
  open: boolean;
  onClose: () => void;
}

export default function AbiHistoryDrawer({ contractId, open, onClose }: Props) {
  const drawerRef = useRef<HTMLDivElement>(null);

  const { data: history, isLoading, isError, error } = useQuery({
    queryKey: ["abi-history", contractId],
    queryFn: () => api.abiHistory(contractId),
    enabled: open && !!contractId,
  });

  // Trap focus and close on Escape
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    drawerRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        aria-hidden="true"
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.4)",
          zIndex: 100,
        }}
      />

      {/* Drawer panel */}
      <div
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label="ABI version history"
        tabIndex={-1}
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          bottom: 0,
          width: "min(480px, 95vw)",
          background: "var(--surface, #fff)",
          borderLeft: "1px solid var(--border)",
          boxShadow: "-4px 0 24px rgba(0,0,0,0.2)",
          zIndex: 101,
          display: "flex",
          flexDirection: "column",
          outline: "none",
        }}
      >
        {/* Drawer header */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "16px 20px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <h2 style={{ fontSize: 16, margin: 0 }}>ABI Version History</h2>
          <button
            type="button"
            aria-label="Close drawer"
            onClick={onClose}
            style={{ fontSize: 18, padding: "2px 8px", lineHeight: 1 }}
          >
            ✕
          </button>
        </div>

        {/* Drawer body */}
        <div style={{ flex: 1, overflowY: "auto", padding: "0 20px" }}>
          {isLoading && (
            <p style={{ color: "var(--muted)", padding: "20px 0" }}>Loading history…</p>
          )}
          {isError && (
            <p style={{ color: "#f85149", padding: "20px 0" }}>
              {(error as Error).message}
            </p>
          )}
          {!isLoading && !isError && history && history.length === 0 && (
            <p style={{ color: "var(--muted)", padding: "20px 0" }}>
              No version history found.
            </p>
          )}
          {!isLoading &&
            !isError &&
            history &&
            history.map((entry, idx) => (
              <VersionCard
                key={entry.id}
                entry={entry}
                prev={idx > 0 ? history[idx - 1] : null}
              />
            ))}
        </div>
      </div>
    </>
  );
}
