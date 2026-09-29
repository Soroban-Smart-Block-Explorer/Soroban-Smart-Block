import { useState, type FormEvent, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { CodeBadgeState } from "../api";

// Issue #796: badge + trust details for reproducible-build verification.

const LABELS: Record<CodeBadgeState, string> = {
  verified_reproducible: "✔ Verified (reproducible)",
  verified_hash_match: "✔ Verified (hash match, non-reproducible toolchain)",
  mismatch: "✗ Mismatch",
  unverified: "Unverified",
  pending: "Verification pending",
  failed: "Verification failed",
};

const COLORS: Record<CodeBadgeState, string> = {
  verified_reproducible: "var(--green, #22c55e)",
  verified_hash_match: "var(--green, #22c55e)",
  mismatch: "var(--danger, #d33)",
  unverified: "var(--muted)",
  pending: "var(--muted)",
  failed: "var(--danger, #d33)",
};

function useCodeVerification(contractId: string) {
  return useQuery({
    queryKey: ["code-verification", contractId],
    queryFn: () => api.codeVerification(contractId),
    enabled: !!contractId,
    refetchInterval: (q) => (q.state.data?.badge.state === "pending" ? 15_000 : false),
  });
}

export function CodeVerificationBadge({ contractId }: { contractId: string }) {
  const { data } = useCodeVerification(contractId);
  if (!data) return null;
  const { state, reason } = data.badge;
  const color = COLORS[state];
  return (
    <span
      data-testid="code-verification-badge"
      title={reason ?? LABELS[state]}
      style={{
        marginLeft: 8,
        padding: "2px 10px",
        borderRadius: 12,
        border: `1px solid ${color}`,
        color,
        fontSize: 11,
        fontWeight: 600,
      }}
    >
      {LABELS[state]}
      {state === "failed" && reason ? ` (${reason})` : ""}
    </span>
  );
}

export function CodeVerificationPanel({ contractId }: { contractId: string }) {
  const { data } = useCodeVerification(contractId);
  const queryClient = useQueryClient();
  const [repo, setRepo] = useState("");
  const [commit, setCommit] = useState("");
  const [rust, setRust] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  if (!data) return null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setMessage(null);
    try {
      await api.requestCodeVerification(
        contractId,
        { source_repo: repo.trim(), commit: commit.trim(), ...(rust.trim() ? { toolchain: { rust: rust.trim() } } : {}) },
        apiKey,
      );
      setMessage("Verification queued.");
      queryClient.invalidateQueries({ queryKey: ["code-verification", contractId] });
    } catch (err) {
      setMessage((err as Error).message);
    }
  };

  const row = (label: string, value: ReactNode) => (
    <p style={{ margin: "4px 0", wordBreak: "break-all" }}>
      <strong>{label}:</strong> {value ?? "—"}
    </p>
  );

  return (
    <section className="card" aria-labelledby="code-verification-title">
      <h3 id="code-verification-title" style={{ marginTop: 0 }}>
        Source verification <CodeVerificationBadge contractId={contractId} />
      </h3>
      {data.badge.state === "mismatch" && (
        <p role="alert">
          Built hash <code>{data.badge.expected}</code> does not match on-chain hash <code>{data.badge.actual}</code>
          {data.badge.upgraded ? " — the contract was upgraded since it was verified." : "."}
        </p>
      )}
      {row("On-chain hash", data.onchain_hash && <code>{data.onchain_hash}</code>)}
      {row("Built hash", data.built_hash && <code>{data.built_hash}</code>)}
      {row(
        "Toolchain",
        data.toolchain && Object.keys(data.toolchain).length
          ? Object.entries(data.toolchain)
              .map(([k, v]) => `${k} ${v}`)
              .join(", ")
          : null,
      )}
      {row(
        "Source",
        data.source_repo && (
          <a href={`${data.source_repo.replace(/\.git$/, "")}/tree/${data.commit}`} target="_blank" rel="noreferrer">
            {data.source_repo} @ {data.commit?.slice(0, 12)}
          </a>
        ),
      )}
      {data.source_retrievable === false && <p>Source no longer retrievable; recorded hashes are kept.</p>}
      {row("Built", data.built_at && new Date(data.built_at).toLocaleString())}
      {data.reason && row("Notes", data.reason)}
      {data.build_log && (
        <details>
          <summary>Build log</summary>
          <pre style={{ maxHeight: 300, overflow: "auto", fontSize: 12 }}>{data.build_log}</pre>
        </details>
      )}
      <p>
        <a href={data.reproduce_doc} target="_blank" rel="noreferrer">
          How to reproduce this build yourself
        </a>
      </p>

      <details>
        <summary>Submit source for verification</summary>
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 480 }}>
          <input required placeholder="https://github.com/org/repo" value={repo} onChange={(e) => setRepo(e.target.value)} />
          <input required placeholder="40-character commit SHA" value={commit} onChange={(e) => setCommit(e.target.value)} />
          <input placeholder="Rust version (optional, e.g. 1.84.0)" value={rust} onChange={(e) => setRust(e.target.value)} />
          <input required type="password" placeholder="API key" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
          <button type="submit">Request verification</button>
          {message && <p role="status">{message}</p>}
        </form>
      </details>
    </section>
  );
}
