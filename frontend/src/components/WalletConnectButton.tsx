/**
 * WalletConnectButton — multi-wallet picker backed by useWallet (issue #914).
 *
 * Shows a "Connect Wallet" button that opens a modal listing all supported
 * wallets. The connected state displays a truncated address with a disconnect
 * option and a network-mismatch warning when applicable.
 */
import { useState } from 'react';
import { useWallet, type WalletId } from '../hooks/useWallet';
import { truncateAddress } from '../utils/strkey';

const WALLETS: { id: WalletId; label: string; icon: string }[] = [
  { id: 'freighter', label: 'Freighter', icon: '🔑' },
  { id: 'xbull', label: 'xBull', icon: '🐂' },
  { id: 'albedo', label: 'Albedo', icon: '🌅' },
  { id: 'lobstr', label: 'Lobstr', icon: '🦞' },
  { id: 'hana', label: 'Hana', icon: '🌸' },
  { id: 'walletconnect', label: 'WalletConnect', icon: '📱' },
  { id: 'ledger', label: 'Ledger', icon: '🔒' },
];

export default function WalletConnectButton() {
  const {
    connected,
    publicKey,
    network,
    walletId,
    connecting,
    error,
    networkMismatch,
    canSignAuthEntries,
    connect,
    disconnect,
  } = useWallet();

  const [modalOpen, setModalOpen] = useState(false);

  if (connected && publicKey) {
    return (
      <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
        {networkMismatch && (
          <span
            style={{ fontSize: 11, color: '#f59e0b', background: 'rgba(245,158,11,0.1)', padding: '2px 8px', borderRadius: 4 }}
            title={`Wallet is on ${network ?? 'unknown'} but the explorer is configured for a different network.`}
          >
            ⚠ Network mismatch
          </span>
        )}
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              padding: '6px 12px',
              background: 'rgba(16,185,129,0.1)',
              border: '1px solid #10b981',
              borderRadius: 6,
              color: '#34d399',
              fontSize: 12,
              fontFamily: 'monospace',
              cursor: 'default',
            }}
            title={`${publicKey}\nWallet: ${walletId ?? 'unknown'}\nAuth entries: ${canSignAuthEntries ? 'supported' : 'not supported'}`}
          >
            {truncateAddress(publicKey)}
          </span>
          <button
            onClick={disconnect}
            style={{
              padding: '6px 10px',
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              color: 'var(--muted)',
              cursor: 'pointer',
              fontSize: 12,
            }}
          >
            Disconnect
          </button>
        </div>
        {!canSignAuthEntries && (
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>
            {walletId} cannot sign auth entries
          </span>
        )}
      </div>
    );
  }

  return (
    <>
      <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
        <button
          onClick={() => setModalOpen(true)}
          disabled={connecting}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 14px',
            background: connecting ? 'var(--surface)' : 'var(--accent)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            color: connecting ? 'var(--muted)' : '#0d1117',
            cursor: connecting ? 'not-allowed' : 'pointer',
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          {connecting ? 'Connecting…' : '⬡ Connect Wallet'}
        </button>
        {error && <span style={{ fontSize: 11, color: '#f87171' }}>{error}</span>}
      </div>

      {modalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Select wallet"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
          onClick={(e) => { if (e.target === e.currentTarget) setModalOpen(false); }}
        >
          <div
            style={{
              background: 'var(--bg)',
              border: '1px solid var(--border)',
              borderRadius: 12,
              padding: '24px 28px',
              width: 340,
              maxWidth: '95vw',
            }}
          >
            <h2 style={{ margin: '0 0 16px', fontSize: 16, fontWeight: 700 }}>Connect a Wallet</h2>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {WALLETS.map((w) => (
                <li key={w.id}>
                  <button
                    onClick={async () => {
                      setModalOpen(false);
                      await connect(w.id);
                    }}
                    style={{
                      width: '100%',
                      textAlign: 'left',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '10px 14px',
                      background: 'var(--surface)',
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                      cursor: 'pointer',
                      fontSize: 14,
                      color: 'var(--text)',
                    }}
                  >
                    <span style={{ fontSize: 20 }}>{w.icon}</span>
                    {w.label}
                  </button>
                </li>
              ))}
            </ul>
            <button
              onClick={() => setModalOpen(false)}
              style={{
                marginTop: 16,
                width: '100%',
                padding: '8px',
                background: 'transparent',
                border: '1px solid var(--border)',
                borderRadius: 8,
                cursor: 'pointer',
                color: 'var(--muted)',
                fontSize: 13,
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  );
}
