/**
 * AbiDiffPage — Issue #521
 *
 * Side-by-side diff of two ABI versions for a contract.
 * Route: /contract/:id/abi-diff?from=1&to=3
 *
 * Features:
 *  - Two version selector dropdowns (from / to)
 *  - Left pane: old version functions, right pane: new version functions
 *  - Added functions highlighted green, removed red, changed yellow
 *  - Param-level diff within changed functions
 *  - Shareable URL with ?from=N&to=M query params
 */
import { useState } from "react";
import { useParams, useSearchParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import type { AbiVersionEntry } from "../api";

// ── Types ─────────────────────────────────────────────────────────────────────

interface FnDef {
  name: string;
  description?: string;
  params?: { name: string; kind?: string; type?: string }[];
}

type DiffStatus = "added" | "removed" | "changed" | "unchanged";

interface FnDiff {
  name: string;
  status: DiffStatus;
  old: FnDef | null;
  new: FnDef | null;
}

// ── Diff algorithm ────────────────────────────────────────────────────────────

function diffFunctions(oldFns: FnDef[] | null, newFns: FnDef[] | null): FnDiff[] {
  const oldMap = new Map<string, FnDef>((oldFns ?? []).map((f) => [f.name, f]));
  const newMap = new Map<string, FnDef>((newFns ?? []).map((f) => [f.name, f]));
  const result: FnDiff[] = [];

  for (const [name, oldFn] of oldMap) {
    if (newMap.has(name)) {
      const newFn = newMap.get(name)!;
      const oldParams = JSON.stringify(
        (oldFn.params ?? []).map((p) => ({ name: p.name, kind: p.kind ?? p.type ?? "" })),
      );
      const newParams = JSON.stringify(
        (newFn.params ?? []).map((p) => ({ name: p.name, kind: p.kind ?? p.type ?? "" })),
      );
      result.push({
        name,
        status: oldParams !== newParams ? "changed" : "unchanged",
        old: oldFn,
        new: newFn,
      });
    } else {
      result.push({ name, status: "removed", old: oldFn, new: null });
    }
  }

  for (const [name, newFn] of newMap) {
    if (!oldMap.has(name)) {
      result.push({ name, status: "added", old: null, new: newFn });
    }
  }

  return result;
}

// ── Colour tokens ─────────────────────────────────────────────────────────────

const STATUS_BG: Record<DiffStatus, string> = {
  added: "rgba(26,127,55,0.12)",
  removed: "rgba(164,14,38,0.12)",
  changed: "rgba(154,103,0,0.12)",
  unchanged: "transparent",
};

const STATUS_BORDER: Record<DiffStatus, string> = {
  added: "#1a7f37",
  removed: "#a40e26",
  changed: "#9a6700",
  unchanged: "var(--border)",
};

const STATUS_LABEL: Record<DiffStatus, string> = {
  added: "added",
  removed: "removed",
  changed: "changed",
  unchanged: "",
};

const STATUS_LABEL_COLOR: Record<DiffStatus, string> = {
  added: "#1a7f37",
  removed: "#a40e26",
  changed: "#9a6700",
  unchanged: "var(--muted)",
};

// ── Sub-components ────────────────────────────────────────────────────────────

function ParamPill({
  name,
  kind,
  highlight,
}: {
  name: string;
  kind: string;
  highlight?: "added" | "removed";
}) {
  const bg =
    highlight === "added"
      ? "rgba(26,127,55,0.2)"
      : highlight === "removed"
        ? "rgba(164,14,38,0.2)"
        : "var(--border)";
  return (
    <code
      style={{
        fontSize: 11,
        background: bg,
        borderRadius: 3,
        padding: "2px 6px",
        marginRight: 4,
        marginBottom: 2,
        display: "inline-block",
      }}
    >
      {name}: {kind}
    </code>
  );
}

function ParamDiff({
  oldParams,
  newParams,
}: {
  oldParams: { name: string; kind: string }[];
  newParams: { name: string; kind: string }[];
}) {
  const oldNames = new Set(oldParams.map((p) => p.name));
  const newNames = new Set(newParams.map((p) => p.name));

  return (
    <div style={{ marginTop: 4 }}>
      {/* Old params — flag removed or changed-kind */}
      {oldParams.map((p) => {
        const inNew = newNames.has(p.name);
        const newKind = newParams.find((np) => np.name === p.name)?.kind;
        const kindChanged = inNew && newKind !== p.kind;
        return (
          <ParamPill
            key={`old-${p.name}`}
            name={p.name}
            kind={p.kind}
            highlight={!inNew || kindChanged ? "removed" : undefined}
          />
        );
      })}
      {/* New params — added or kind-changed */}
      {newParams
        .filter((p) => {
          const inOld = oldNames.has(p.name);
          const oldKind = oldParams.find((op) => op.name === p.name)?.kind;
          return !inOld || oldKind !== p.kind;
        })
        .map((p) => (
          <ParamPill key={`new-${p.name}`} name={p.name} kind={p.kind} highlight="added" />
        ))}
      {/* Unchanged params — no highlight */}
      {oldParams
        .filter(
          (p) =>
            newNames.has(p.name) &&
            newParams.find((np) => np.name === p.name)?.kind === p.kind,
        )
        .map((p) => (
          <ParamPill key={`unchanged-${p.name}`} name={p.name} kind={p.kind} />
        ))}
    </div>
  );
}

function FunctionRow({ diff }: { diff: FnDiff }) {
  const activeFn = diff.new ?? diff.old;

  const oldParams = (diff.old?.params ?? []).map((p) => ({
    name: p.name,
    kind: p.kind ?? p.type ?? "unknown",
  }));
  const newParams = (diff.new?.params ?? []).map((p) => ({
    name: p.name,
    kind: p.kind ?? p.type ?? "unknown",
  }));

  return (
    <div
      style={{
        background: STATUS_BG[diff.status],
        borderLeft: `3px solid ${STATUS_BORDER[diff.status]}`,
        padding: "8px 12px",
        borderRadius: "0 4px 4px 0",
        marginBottom: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <code style={{ fontSize: 13, fontWeight: 700 }}>{diff.name}</code>
        {diff.status !== "unchanged" && (
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: STATUS_LABEL_COLOR[diff.status],
              padding: "1px 6px",
              border: `1px solid ${STATUS_BORDER[diff.status]}`,
              borderRadius: 10,
            }}
          >
            {STATUS_LABEL[diff.status]}
          </span>
        )}
      </div>

      {activeFn?.description && (
        <p style={{ fontSize: 12, color: "var(--muted)", margin: "2px 0 0" }}>
          {activeFn.description}
        </p>
      )}

      {diff.status === "changed" ? (
        <ParamDiff oldParams={oldParams} newParams={newParams} />
      ) : (
        <div style={{ marginTop: 4 }}>
          {(activeFn?.params ?? []).map((p) => (
            <ParamPill
              key={p.name}
              name={p.name}
              kind={p.kind ?? p.type ?? "unknown"}
              highlight={
                diff.status === "added"
                  ? "added"
                  : diff.status === "removed"
                    ? "removed"
                    : undefined
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Version selector ──────────────────────────────────────────────────────────

function VersionSelect({
  id,
  label,
  value,
  versions,
  onChange,
  excludeVersion,
}: {
  id: string;
  label: string;
  value: number;
  versions: AbiVersionEntry[];
  onChange: (v: number) => void;
  excludeVersion?: number;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <label htmlFor={id} style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600 }}>
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ padding: "4px 8px", fontSize: 13 }}
      >
        {versions
          .filter((v) => v.abi_version !== excludeVersion)
          .map((v) => (
            <option key={v.abi_version} value={v.abi_version}>
              v{v.abi_version} — ledger #{v.min_ledger}
            </option>
          ))}
      </select>
    </div>
  );
}

// ── Diff summary bar ──────────────────────────────────────────────────────────

function DiffSummary({ diffs }: { diffs: FnDiff[] }) {
  const added = diffs.filter((d) => d.status === "added").length;
  const removed = diffs.filter((d) => d.status === "removed").length;
  const changed = diffs.filter((d) => d.status === "changed").length;
  const unchanged = diffs.filter((d) => d.status === "unchanged").length;

  if (added + removed + changed === 0) {
    return (
      <p style={{ fontSize: 13, color: "var(--muted)" }}>
        No differences between these versions.
      </p>
    );
  }

  return (
    <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 13 }}>
      {added > 0 && (
        <span style={{ color: STATUS_LABEL_COLOR.added, fontWeight: 600 }}>
          +{added} added
        </span>
      )}
      {removed > 0 && (
        <span style={{ color: STATUS_LABEL_COLOR.removed, fontWeight: 600 }}>
          −{removed} removed
        </span>
      )}
      {changed > 0 && (
        <span style={{ color: STATUS_LABEL_COLOR.changed, fontWeight: 600 }}>
          ~{changed} changed
        </span>
      )}
      {unchanged > 0 && (
        <span style={{ color: "var(--muted)" }}>{unchanged} unchanged</span>
      )}
    </div>
  );
}

// ── Split pane ────────────────────────────────────────────────────────────────

function Pane({
  title,
  version,
  fns,
  diffs,
  side,
}: {
  title: string;
  version: number;
  fns: FnDef[];
  diffs: FnDiff[];
  side: "old" | "new";
}) {
  const sideDiffs = diffs.filter((d) => {
    if (side === "old") return d.status !== "added";
    return d.status !== "removed";
  });

  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        border: "1px solid var(--border)",
        borderRadius: 6,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "10px 14px",
          background: "var(--surface2, var(--border))",
          borderBottom: "1px solid var(--border)",
          fontWeight: 600,
          fontSize: 13,
        }}
      >
        {title} — v{version} ({fns.length} function{fns.length !== 1 ? "s" : ""})
      </div>
      <div style={{ padding: 12 }}>
        {sideDiffs.length === 0 && (
          <p style={{ fontSize: 12, color: "var(--muted)" }}>No functions.</p>
        )}
        {sideDiffs.map((d) => (
          <FunctionRow key={d.name} diff={d} />
        ))}
      </div>
    </div>
  );
}

// ── Legend ────────────────────────────────────────────────────────────────────

function DiffLegend() {
  const items: DiffStatus[] = ["added", "removed", "changed", "unchanged"];
  return (
    <div style={{ display: "flex", gap: 16, fontSize: 12, color: "var(--muted)", flexWrap: "wrap" }}>
      {items.map((s) => (
        <span key={s} style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span
            style={{
              width: 12,
              height: 12,
              borderRadius: 2,
              background: STATUS_BG[s],
              border: `2px solid ${STATUS_BORDER[s]}`,
              display: "inline-block",
            }}
          />
          {s}
        </span>
      ))}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AbiDiffPage() {
  const { id: contractId } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [shareLabel, setShareLabel] = useState("Share");

  const { data: historyResp, isLoading, isError, error } = useQuery({
    queryKey: ["abi-history", contractId],
    queryFn: () => api.abiHistory(contractId!),
    enabled: !!contractId,
  });

  // api.abiHistory may return AbiVersionEntry[] or AbiHistoryResponse shape
  const versions: AbiVersionEntry[] = Array.isArray(historyResp)
    ? (historyResp as AbiVersionEntry[])
    : ((historyResp as { history?: AbiVersionEntry[] })?.history ?? []);

  const firstVer = versions[0]?.abi_version ?? 0;
  const lastVer = versions[versions.length - 1]?.abi_version ?? 0;

  const fromParam = Number(searchParams.get("from") ?? firstVer);
  const toParam = Number(searchParams.get("to") ?? lastVer);

  const fromVersion =
    versions.find((v) => v.abi_version === fromParam)?.abi_version ?? firstVer;
  const toVersion =
    versions.find((v) => v.abi_version === toParam)?.abi_version ?? lastVer;

  function setFrom(v: number) {
    setSearchParams({ from: String(v), to: String(toVersion) }, { replace: true });
  }

  function setTo(v: number) {
    setSearchParams({ from: String(fromVersion), to: String(v) }, { replace: true });
  }

  function copyShareUrl() {
    const shareUrl = `${window.location.origin}/contract/${contractId}/abi-diff?from=${fromVersion}&to=${toVersion}`;
    navigator.clipboard.writeText(shareUrl).then(() => {
      setShareLabel("Copied!");
      setTimeout(() => setShareLabel("Share"), 2000);
    });
  }

  const oldEntry = versions.find((v) => v.abi_version === fromVersion);
  const newEntry = versions.find((v) => v.abi_version === toVersion);

  const oldFns: FnDef[] = (oldEntry?.functions ?? []).map((f) => ({
    name: f.name,
    description: f.description,
    params: (f.params ?? []).map((p) => ({ name: p.name, kind: p.kind ?? "" })),
  }));
  const newFns: FnDef[] = (newEntry?.functions ?? []).map((f) => ({
    name: f.name,
    description: f.description,
    params: (f.params ?? []).map((p) => ({ name: p.name, kind: p.kind ?? "" })),
  }));

  const diffs = diffFunctions(oldFns, newFns);

  if (isLoading) {
    return <p style={{ padding: 32, color: "var(--muted)" }}>Loading ABI history…</p>;
  }

  if (isError) {
    return (
      <p style={{ padding: 32, color: "#f85149" }}>
        Error: {(error as Error).message}
      </p>
    );
  }

  if (versions.length === 0) {
    return (
      <div style={{ padding: 16 }}>
        <Link
          to={`/contract/${contractId}`}
          style={{ fontSize: 13, color: "var(--muted)", display: "block", marginBottom: 16 }}
        >
          ← Back to contract
        </Link>
        <p style={{ color: "var(--muted)" }}>No ABI version history found for this contract.</p>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Breadcrumb */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Link to={`/contract/${contractId}`} style={{ fontSize: 13, color: "var(--muted)" }}>
          ← {contractId}
        </Link>
        <span style={{ color: "var(--muted)" }}>/</span>
        <span style={{ fontSize: 13, fontWeight: 600 }}>ABI Diff</span>
      </div>

      {/* Heading */}
      <div>
        <h1 style={{ fontSize: 20, marginBottom: 4 }}>ABI Version Diff</h1>
        <p style={{ color: "var(--muted)", fontSize: 14 }}>
          Compare two ABI versions to audit changes in function signatures and parameters.
        </p>
      </div>

      {/* Controls */}
      <div
        style={{
          display: "flex",
          gap: 16,
          alignItems: "flex-end",
          flexWrap: "wrap",
          padding: "12px 16px",
          background: "var(--surface2, var(--border))",
          borderRadius: 8,
          border: "1px solid var(--border)",
        }}
      >
        <VersionSelect
          id="from-version"
          label="From (old)"
          value={fromVersion}
          versions={versions}
          onChange={setFrom}
          excludeVersion={toVersion}
        />

        <span
          aria-hidden="true"
          style={{ fontSize: 18, alignSelf: "center", color: "var(--muted)", paddingBottom: 2 }}
        >
          →
        </span>

        <VersionSelect
          id="to-version"
          label="To (new)"
          value={toVersion}
          versions={versions}
          onChange={setTo}
          excludeVersion={fromVersion}
        />

        <div style={{ marginLeft: "auto" }}>
          <button
            type="button"
            onClick={copyShareUrl}
            title="Copy shareable link to this comparison"
            style={{ padding: "6px 14px", fontSize: 13 }}
          >
            🔗 {shareLabel}
          </button>
        </div>
      </div>

      {/* Summary */}
      <DiffSummary diffs={diffs} />

      {/* Split pane diff */}
      <div style={{ display: "flex", gap: 12 }}>
        <Pane title="Old" version={fromVersion} fns={oldFns} diffs={diffs} side="old" />
        <Pane title="New" version={toVersion} fns={newFns} diffs={diffs} side="new" />
      </div>

      {/* Legend */}
      <DiffLegend />
    </div>
  );
}
