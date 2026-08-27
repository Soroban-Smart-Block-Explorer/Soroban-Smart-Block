import { useFreighter } from '../hooks/useFreighter';
import { truncateAddress } from '../utils/strkey';

export default function WalletConnectButton() {
  const { available, connected, publicKey, connecting, error, connect, disconnect } = useFreighter();

  if (!available) {
    return (
      <a
        href="https://www.freighter.app/"
        target="_blank"
        rel="noopener noreferrer"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 14px',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          color: 'var(--muted)',
          fontSize: 13,
          textDecoration: 'none',
        }}
      >
        Install Freighter
      </a>
    );
  }

  if (connected && publicKey) {
    return (
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
          }}
          title={publicKey}
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
    );
  }

  return (
    <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
      <button
        onClick={connect}
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
      {error && (
        <span style={{ fontSize: 11, color: '#f87171' }}>{error}</span>
      )}
    </div>
  );
}
