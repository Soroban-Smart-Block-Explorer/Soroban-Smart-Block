/**
 * WalletConnectButton — multi-wallet connect UI (#914).
 *
 * Uses the unified useWallet() abstraction instead of useFreighter() directly.
 * Shows a wallet-picker modal when no wallet is connected, and displays the
 * connected address + a disconnect action when connected.
 *
 * Network mismatch (wallet on different network from explorer) is surfaced as
 * a warning badge next to the address.
 */

import { useState } from "react";
import { useWallet, type WalletId } from "../hooks/useWallet";
import { truncateAddress } from "../utils/strkey";

interface WalletOption {
  id: WalletId;
  name: string;
  icon: string;
}

const WALLET_OPTIONS: WalletOption[] = [
  { id: "freighter", name: "Freighter", icon: "⬡" },
  { id: "xbull", name: "xBull", icon: "✦" },
  { id: "albedo", name: "Albedo", icon: "◈" },
  { id: "lobstr", name: "Lobstr", icon: "🦞" },
];

function WalletPickerModal({
  onSelect,
  onClose,
  connecting,
  error,
}: {
  onSelect: (id: WalletId) => void;
  onClose: () => void;
  connecting: boolean;
  error: string | null;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Connect wallet"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.6)",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          padding: 24,
          minWidth: 320,
          maxWidth: 380,
          width: "100%",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 16,
          }}
        >
          <h2 style={{ fontSize: 16, fontWeight: 700 }}>Connect Wallet</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              background: "none",
              border: "none",
              color: "var(--muted)",
              cursor: "pointer",
              fontSize: 18,
            }}
          >
            ✕
          </button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {WALLET_OPTIONS.map((w) => (
            <button
              key={w.id}
              type="button"
              disabled={connecting}
              onClick={() => onSelect(w.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "12px 16px",
                background: "var(--background)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                cursor: connecting ? "not-allowed" : "pointer",
                fontSize: 14,
                fontWeight: 500,
                color: "var(--text)",
                textAlign: "left",
                opacity: w.id !== "freighter" ? 0.5 : 1,
              }}
              title={w.id !== "freighter" ? "Coming soon" : undefined}
            >
              <span style={{ fontSize: 20 }}>{w.icon}</span>
              {w.name}
              {w.id !== "freighter" && (
                <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--muted)" }}>
                  Coming soon
                </span>
              )}
            </button>
          ))}
        </div>

        {error && (
          <p role="alert" style={{ marginTop: 12, fontSize: 12, color: "#f87171" }}>
            {error}
          </p>
        )}

        <p style={{ marginTop: 16, fontSize: 11, color: "var(--muted)" }}>
          No private keys leave this page. Signing is performed entirely by the
          wallet extension.
        </p>
      </div>
    </div>
  );
}

export default function WalletConnectButton() {
  const { connected, publicKey, connecting, error, network, networkMismatch, connect, disconnect } =
    useWallet();
  const [pickerOpen, setPickerOpen] = useState(false);

  async function handleSelect(id: WalletId) {
    setPickerOpen(false);
    await connect(id);
  }

  if (connected && publicKey) {
    return (
      <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
        {networkMismatch && (
          <span
            title={`Wallet is on a different network than the explorer`}
            style={{
              fontSize: 11,
              color: "#fbbf24",
              border: "1px solid #fbbf24",
              borderRadius: 4,
              padding: "2px 6px",
            }}
          >
            ⚠ Network mismatch
          </span>
        )}
        <span
          style={{
            padding: "6px 12px",
            background: "rgba(16,185,129,0.1)",
            border: "1px solid #10b981",
            borderRadius: 6,
            color: "#34d399",
            fontSize: 12,
            fontFamily: "monospace",
          }}
          title={`${publicKey}${network ? ` · ${network}` : ""}`}
        >
          {truncateAddress(publicKey)}
        </span>
        <button
          type="button"
          onClick={disconnect}
          style={{
            padding: "6px 10px",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            color: "var(--muted)",
            cursor: "pointer",
            fontSize: 12,
          }}
        >
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <>
      <div style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          disabled={connecting}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "6px 14px",
            background: connecting ? "var(--surface)" : "var(--accent)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            color: connecting ? "var(--muted)" : "#0d1117",
            cursor: connecting ? "not-allowed" : "pointer",
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          {connecting ? "Connecting…" : "⬡ Connect Wallet"}
        </button>
        {error && <span style={{ fontSize: 11, color: "#f87171" }}>{error}</span>}
      </div>

      {pickerOpen && (
        <WalletPickerModal
          onSelect={handleSelect}
          onClose={() => setPickerOpen(false)}
          connecting={connecting}
          error={error}
        />
      )}
    </>
  );
}
