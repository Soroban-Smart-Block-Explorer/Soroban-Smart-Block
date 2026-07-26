import { useState } from "react";
import type { NftToken } from "../api";

interface Props {
  token: NftToken;
  onClick: (token: NftToken) => void;
}

/** Truncate a Stellar address to the first 6 + last 4 characters. */
function truncateAddress(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export default function NftCard({ token, onClick }: Props) {
  const [copied, setCopied] = useState(false);

  const imageUrl: string | null =
    typeof token.metadata?.image === "string" && token.metadata.image.trim()
      ? token.metadata.image
      : null;

  const displayName: string =
    typeof token.metadata?.name === "string" && token.metadata.name.trim()
      ? token.metadata.name
      : `Token #${token.token_id}`;

  function handleCopy(e: React.MouseEvent) {
    e.stopPropagation();
    navigator.clipboard.writeText(token.owner).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <article
      className="card"
      role="button"
      tabIndex={0}
      aria-label={`View details for ${displayName}`}
      onClick={() => onClick(token)}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onClick(token)}
      style={{ cursor: "pointer", padding: 0, overflow: "hidden" }}
    >
      {/* NFT image / placeholder */}
      <div
        style={{
          width: "100%",
          aspectRatio: "1 / 1",
          background: "var(--bg)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        {imageUrl ? (
          <img
            src={imageUrl}
            alt={displayName}
            loading="lazy"
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
        ) : (
          // SVG placeholder with token ID
          <svg
            viewBox="0 0 100 100"
            style={{ width: "60%", height: "60%", opacity: 0.25 }}
            aria-hidden="true"
          >
            <rect width="100" height="100" rx="8" fill="var(--border)" />
            <text
              x="50"
              y="55"
              textAnchor="middle"
              fontSize="14"
              fill="var(--muted)"
              fontFamily="system-ui, sans-serif"
            >
              #{token.token_id}
            </text>
          </svg>
        )}
      </div>

      {/* Card body */}
      <div style={{ padding: "12px 14px 14px" }}>
        <p
          style={{
            fontWeight: 600,
            fontSize: 13,
            marginBottom: 6,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={displayName}
        >
          {displayName}
        </p>

        {/* Owner row */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            marginBottom: 6,
          }}
        >
          <span style={{ color: "var(--muted)", fontSize: 11 }}>Owner</span>
          <code
            style={{ fontSize: 11, color: "var(--text)", flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}
            title={token.owner}
          >
            {truncateAddress(token.owner)}
          </code>
          <button
            onClick={handleCopy}
            aria-label="Copy owner address"
            title={copied ? "Copied!" : "Copy owner address"}
            style={{
              padding: "2px 6px",
              fontSize: 10,
              background: "var(--border)",
              color: "var(--text)",
              borderRadius: 4,
              flexShrink: 0,
            }}
          >
            {copied ? "✓" : "⎘"}
          </button>
        </div>

        {/* Last transfer ledger */}
        {token.last_transfer_ledger != null && (
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <span style={{ color: "var(--muted)", fontSize: 11 }}>Ledger</span>
            <span className="badge" style={{ fontSize: 10 }}>
              {token.last_transfer_ledger.toLocaleString()}
            </span>
          </div>
        )}
      </div>
    </article>
  );
}
