/**
 * RegistrationSuccessPage — Issue #524
 *
 * Shown after a successful contract registration.
 * Route: /contracts/register/success?id=CABC...&name=MyContract
 *
 * Features:
 *  - Contract ID with copy-to-clipboard button + transient "Copied!" tooltip
 *  - Link to contract detail page (/contract/:id)
 *  - Stellar.expert link to the contract address
 *  - Instructions for calling register_contract on-chain (verified badge)
 *  - Share button: Twitter/X pre-filled tweet
 *  - "View your contract" CTA
 */
import { useState } from "react";
import { useSearchParams, useNavigate, Link } from "react-router-dom";

// ── Stellar Expert base URL ───────────────────────────────────────────────────
const STELLAR_EXPERT_BASE =
  (import.meta.env.VITE_STELLAR_NETWORK === "mainnet"
    ? "https://stellar.expert/explorer/public"
    : "https://stellar.expert/explorer/testnet") +
  "/contract";

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildTweetText(name: string, contractId: string): string {
  const url = `${window.location.origin}/contract/${encodeURIComponent(contractId)}`;
  return `I just registered ${name || contractId} contract on @SorobanExplorer — decode its events at ${url}`;
}

function buildTweetUrl(name: string, contractId: string): string {
  const text = buildTweetText(name, contractId);
  return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
}

// ── CopyButton component ──────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [tooltip, setTooltip] = useState<string | null>(null);

  function handleCopy() {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setTooltip("Copied!");
        setTimeout(() => setTooltip(null), 2000);
      })
      .catch(() => {
        setTooltip("Failed to copy");
        setTimeout(() => setTooltip(null), 2000);
      });
  }

  return (
    <span style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        aria-label="Copy to clipboard"
        title="Copy to clipboard"
        onClick={handleCopy}
        style={{
          padding: "2px 8px",
          fontSize: 12,
          cursor: "pointer",
          marginLeft: 8,
        }}
      >
        📋
      </button>
      {tooltip && (
        <span
          role="status"
          aria-live="polite"
          style={{
            position: "absolute",
            bottom: "calc(100% + 4px)",
            left: "50%",
            transform: "translateX(-50%)",
            background: "#1a7f37",
            color: "#fff",
            padding: "3px 8px",
            borderRadius: 4,
            fontSize: 11,
            whiteSpace: "nowrap",
            pointerEvents: "none",
            zIndex: 10,
          }}
        >
          {tooltip}
        </span>
      )}
    </span>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function RegistrationSuccessPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const contractId = searchParams.get("id") ?? "";
  const contractName = searchParams.get("name") ?? contractId;
  const network = import.meta.env.VITE_STELLAR_NETWORK ?? "testnet";

  // If there's no contractId, the user landed here directly — redirect them.
  if (!contractId) {
    return (
      <div style={{ maxWidth: 680, display: "flex", flexDirection: "column", gap: 16 }}>
        <h1 style={{ fontSize: 22 }}>Nothing to show</h1>
        <p style={{ color: "var(--muted)" }}>
          No contract ID provided. Please{" "}
          <Link to="/contracts/register" style={{ color: "inherit" }}>
            register a contract
          </Link>{" "}
          first.
        </p>
      </div>
    );
  }

  const stellarExpertUrl = `${STELLAR_EXPERT_BASE}/${contractId}`;
  const contractDetailUrl = `/contract/${contractId}`;
  const tweetUrl = buildTweetUrl(contractName, contractId);

  return (
    <div style={{ maxWidth: 680, display: "flex", flexDirection: "column", gap: 28 }}>
      {/* Success banner */}
      <div
        role="status"
        aria-live="polite"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          padding: "18px 22px",
          background: "rgba(26,127,55,0.12)",
          border: "1px solid #1a7f37",
          borderRadius: 10,
        }}
      >
        <span style={{ fontSize: 30 }} aria-hidden="true">
          ✅
        </span>
        <div>
          <h1 style={{ fontSize: 20, margin: 0, color: "#1a7f37" }}>
            Contract registered successfully!
          </h1>
          <p style={{ margin: "4px 0 0", fontSize: 14, color: "var(--muted)" }}>
            {contractName && contractName !== contractId ? (
              <>
                <strong>{contractName}</strong> is now in the registry.
              </>
            ) : (
              "Your contract is now in the registry."
            )}
          </p>
        </div>
      </div>

      {/* Contract ID card */}
      <section
        style={{
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: "16px 20px",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <h2 style={{ fontSize: 14, marginBottom: 0, color: "var(--muted)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>
          Contract ID
        </h2>
        <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 4 }}>
          <code
            style={{
              fontSize: 14,
              fontFamily: "monospace",
              wordBreak: "break-all",
              flex: 1,
            }}
          >
            {contractId}
          </code>
          <CopyButton text={contractId} />
        </div>

        {/* Links row */}
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 6 }}>
          <Link
            to={contractDetailUrl}
            style={{
              fontSize: 13,
              color: "inherit",
              textDecoration: "underline",
              textUnderlineOffset: 3,
            }}
          >
            View in explorer →
          </Link>
          <a
            href={stellarExpertUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontSize: 13,
              color: "inherit",
              textDecoration: "underline",
              textUnderlineOffset: 3,
            }}
          >
            View on Stellar.expert ↗
          </a>
        </div>
      </section>

      {/* Verified badge instructions */}
      <section
        style={{
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: "16px 20px",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <h2 style={{ fontSize: 15, marginBottom: 0 }}>
          🏅 Get the <em>Verified</em> badge
        </h2>
        <p style={{ fontSize: 13, color: "var(--muted)", margin: 0 }}>
          Your ABI is now in the off-chain registry. To earn the on-chain{" "}
          <strong>Verified</strong> badge, call{" "}
          <code>register_contract</code> on the Soroban Explorer smart contract:
        </p>
        <ol style={{ fontSize: 13, paddingLeft: 20, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
          <li>
            Install the{" "}
            <a
              href="https://developers.stellar.org/docs/tools/developer-tools/cli/stellar-cli"
              target="_blank"
              rel="noopener noreferrer"
            >
              Stellar CLI
            </a>
            .
          </li>
          <li>
            Call{" "}
            <code style={{ fontSize: 12 }}>
              stellar contract invoke --id {import.meta.env.VITE_CONTRACT_ID ?? "<EXPLORER_CONTRACT_ID>"} -- register_contract
            </code>{" "}
            with your contract ID and metadata.
          </li>
          <li>
            The indexer will detect the on-chain event and mark your contract as{" "}
            <strong>Verified ✓</strong>.
          </li>
        </ol>
        <p style={{ fontSize: 12, color: "var(--muted)", margin: 0 }}>
          See the{" "}
          <a
            href="/docs/guides/register-contract"
            target="_blank"
            rel="noopener noreferrer"
          >
            full guide
          </a>{" "}
          for a step-by-step walkthrough.
        </p>
      </section>

      {/* Share + CTA row */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {/* Twitter/X share */}
        <a
          href={tweetUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Share on X (Twitter): I just registered ${contractName} on SorobanExplorer`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            padding: "9px 18px",
            background: "#000",
            color: "#fff",
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 600,
            textDecoration: "none",
          }}
        >
          {/* X logo (simple SVG) */}
          <svg
            aria-hidden="true"
            width="14"
            height="14"
            viewBox="0 0 1200 1227"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M714.163 519.284L1160.89 0H1055.03L667.137 450.887L357.328 0H0L468.492 681.821L0 1226.37H105.866L515.491 750.218L842.672 1226.37H1200L714.137 519.284H714.163ZM569.165 687.828L521.697 619.934L144.011 79.6904H306.615L611.412 515.685L658.88 583.579L1055.08 1150.3H892.476L569.165 687.854V687.828Z"
              fill="white"
            />
          </svg>
          Share on X
        </a>

        {/* View contract CTA */}
        <button
          type="button"
          onClick={() => navigate(contractDetailUrl)}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            padding: "9px 18px",
            fontWeight: 600,
            fontSize: 13,
            borderRadius: 6,
            cursor: "pointer",
          }}
        >
          View your contract →
        </button>
      </div>

      {/* Register another */}
      <p style={{ fontSize: 13, color: "var(--muted)" }}>
        <Link to="/contracts/register">← Register another contract</Link>
      </p>
    </div>
  );
}
