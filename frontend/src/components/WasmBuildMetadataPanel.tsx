/**
 * WASM Build Metadata Panel
 *
 * Shows the reproducible-build fingerprint for a contract's deployed WASM:
 * hash, compiler (rustc) version, SDK version, build timestamp, and size.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { truncateAddress } from "../utils/strkey";

interface Props {
  contractId: string;
}

export default function WasmBuildMetadataPanel({ contractId }: Props) {
  const [copied, setCopied] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ["wasm-metadata", contractId],
    queryFn: () => api.wasmMetadata(contractId),
    enabled: !!contractId,
    retry: false,
  });

  function copyHash() {
    if (!data?.wasm_hash) return;
    navigator.clipboard.writeText(data.wasm_hash).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  if (isLoading) {
    return <p style={{ color: "var(--muted)" }}>Loading WASM build metadata…</p>;
  }

  if (error || !data) {
    return (
      <div className="card" style={{ color: "var(--muted)", fontSize: 13 }}>
        <strong style={{ display: "block", color: "var(--text)", fontSize: 14, marginBottom: 6 }}>
          WASM not indexed
        </strong>
        The indexer has not seen a WASM upload for this contract yet.
      </div>
    );
  }

  const sizeLabel = data.size_bytes != null ? `${data.size_bytes.toLocaleString()} bytes` : "Unknown";

  return (
    <div className="card">
      <h3 style={{ fontSize: 14, marginBottom: 12 }}>WASM Build Metadata</h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 13 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ color: "var(--muted)", minWidth: 120 }}>WASM hash</span>
          <code style={{ fontFamily: "monospace" }}>{truncateAddress(data.wasm_hash, 10, 8)}</code>
          <button
            onClick={copyHash}
            style={{
              padding: "2px 8px",
              fontSize: 11,
              background: copied ? "var(--green, #22c55e)" : "var(--bg2, #1e1e2e)",
              color: copied ? "#fff" : "var(--muted)",
              border: "1px solid var(--border, #333)",
              borderRadius: 4,
              cursor: "pointer",
            }}
          >
            {copied ? "✓ Copied!" : "Copy"}
          </button>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <span style={{ color: "var(--muted)", minWidth: 120 }}>Compiler</span>
          <span>{data.compiler ?? "Unknown"}</span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <span style={{ color: "var(--muted)", minWidth: 120 }}>SDK version</span>
          <span>{data.sdk_version ?? "Unknown"}</span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <span style={{ color: "var(--muted)", minWidth: 120 }}>Contract size</span>
          <span>{sizeLabel}</span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <span style={{ color: "var(--muted)", minWidth: 120 }}>Indexed at</span>
          <span>{data.created_at ? new Date(data.created_at).toLocaleString() : "Unknown"}</span>
        </div>
      </div>
    </div>
  );
}
