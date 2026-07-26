import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import type { NftToken, NftHistoryEvent } from "../api";

interface Props {
  contractId: string;
  token: NftToken;
  onClose: () => void;
}

function truncateAddress(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function NftDetailModal({ contractId, token, onClose }: Props) {
  const overlayRef = useRef<HTMLDivElement>(null);

  // Close on Escape key
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  // Trap focus inside the modal
  useEffect(() => {
    const firstFocusable = overlayRef.current?.querySelector<HTMLElement>(
      "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
    );
    firstFocusable?.focus();
  }, []);

  const {
    data: history,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["nft-history", contractId, token.token_id],
    queryFn: () => api.nftHistory(contractId, token.token_id),
  });

  const imageUrl: string | null =
    typeof token.metadata?.image === "string" && token.metadata.image.trim()
      ? token.metadata.image
      : null;

  const displayName =
    typeof token.metadata?.name === "string" && token.metadata.name.trim()
      ? token.metadata.name
      : `Token #${token.token_id}`;

  const attributes = Array.isArray(token.metadata?.attributes)
    ? (token.metadata!.attributes as { trait_type: string; value: string | number }[])
    : [];

  function handleOverlayClick(e: React.MouseEvent) {
    if (e.target === overlayRef.current) onClose();
  }

  return (
    // Full-screen overlay
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label={`NFT detail — ${displayName}`}
      onClick={handleOverlayClick}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: 16,
      }}
    >
      <div
        className="card"
        style={{
          width: "100%",
          maxWidth: 680,
          maxHeight: "90vh",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 20,
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
          <div>
            <h2 style={{ fontSize: 18, marginBottom: 4 }}>{displayName}</h2>
            <span style={{ color: "var(--muted)", fontSize: 12 }}>Token ID: {token.token_id}</span>
          </div>
          <button
            onClick={onClose}
            aria-label="Close modal"
            style={{
              background: "var(--border)",
              color: "var(--text)",
              padding: "4px 10px",
              fontSize: 16,
              flexShrink: 0,
            }}
          >
            ✕
          </button>
        </div>

        {/* Image + metadata side-by-side on wider screens */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: imageUrl ? "1fr 1fr" : "1fr",
            gap: 16,
          }}
        >
          {imageUrl && (
            <img
              src={imageUrl}
              alt={displayName}
              style={{
                width: "100%",
                borderRadius: 8,
                border: "1px solid var(--border)",
                objectFit: "cover",
                aspectRatio: "1 / 1",
              }}
            />
          )}

          {/* Current metadata */}
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <section className="card" style={{ padding: 12 }}>
              <h3 style={{ fontSize: 13, color: "var(--muted)", marginBottom: 8 }}>Current Owner</h3>
              <code style={{ fontSize: 12, wordBreak: "break-all" }}>{token.owner}</code>
            </section>

            {token.last_transfer_ledger != null && (
              <section className="card" style={{ padding: 12 }}>
                <h3 style={{ fontSize: 13, color: "var(--muted)", marginBottom: 4 }}>Last Transfer</h3>
                <span className="badge">Ledger {token.last_transfer_ledger.toLocaleString()}</span>
              </section>
            )}

            {token.metadata?.description && (
              <section className="card" style={{ padding: 12 }}>
                <h3 style={{ fontSize: 13, color: "var(--muted)", marginBottom: 4 }}>Description</h3>
                <p style={{ fontSize: 13, lineHeight: 1.5 }}>{String(token.metadata.description)}</p>
              </section>
            )}

            {attributes.length > 0 && (
              <section className="card" style={{ padding: 12 }}>
                <h3 style={{ fontSize: 13, color: "var(--muted)", marginBottom: 8 }}>Attributes</h3>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {attributes.map((attr, i) => (
                    <div
                      key={i}
                      className="card"
                      style={{
                        padding: "4px 8px",
                        textAlign: "center",
                        minWidth: 80,
                      }}
                    >
                      <div style={{ fontSize: 10, color: "var(--muted)", marginBottom: 2 }}>
                        {attr.trait_type}
                      </div>
                      <div style={{ fontSize: 12, fontWeight: 600 }}>{String(attr.value)}</div>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        </div>

        {/* Transfer + Mint history */}
        <section>
          <h3 style={{ fontSize: 14, marginBottom: 10 }}>Transfer & Mint History</h3>

          {isLoading && <p style={{ color: "var(--muted)", fontSize: 13 }}>Loading history…</p>}

          {error && (
            <p style={{ color: "#f85149", fontSize: 13 }}>
              Failed to load history: {(error as Error).message}
            </p>
          )}

          {history && history.events.length === 0 && (
            <p style={{ color: "var(--muted)", fontSize: 13 }}>No indexed events found for this token.</p>
          )}

          {history && history.events.length > 0 && (
            <div
              style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 320, overflowY: "auto" }}
              role="list"
              aria-label="Token transfer history"
            >
              {history.events.map((event: NftHistoryEvent) => (
                <div
                  key={event.seq}
                  className="card"
                  role="listitem"
                  style={{ padding: "10px 12px", display: "flex", flexDirection: "column", gap: 4 }}
                >
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <span
                      className="badge"
                      style={{
                        background: event.function === "mint" ? "#1a3a22" : "var(--border)",
                        color: event.function === "mint" ? "var(--green)" : "var(--text)",
                        fontSize: 11,
                      }}
                    >
                      {event.function}
                    </span>
                    <span style={{ color: "var(--muted)", fontSize: 11 }}>
                      Ledger {event.ledger.toLocaleString()}
                    </span>
                    {event.tx_hash && (
                      <code
                        style={{ fontSize: 10, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis" }}
                        title={event.tx_hash}
                      >
                        {truncateAddress(event.tx_hash)}
                      </code>
                    )}
                    <span style={{ marginLeft: "auto", color: "var(--muted)", fontSize: 10 }}>
                      {formatDate(event.created_at)}
                    </span>
                  </div>
                  <p style={{ fontSize: 12, color: "var(--text)", marginTop: 2 }}>
                    {event.description}
                  </p>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Raw metadata (collapsible) */}
        {token.metadata && (
          <details>
            <summary
              style={{
                cursor: "pointer",
                fontSize: 13,
                color: "var(--muted)",
                userSelect: "none",
              }}
            >
              Raw metadata JSON
            </summary>
            <pre
              className="card"
              style={{
                marginTop: 8,
                padding: 10,
                fontSize: 11,
                overflow: "auto",
                maxHeight: 200,
                background: "var(--bg)",
              }}
            >
              {JSON.stringify(token.metadata, null, 2)}
            </pre>
          </details>
        )}
      </div>
    </div>
  );
}
