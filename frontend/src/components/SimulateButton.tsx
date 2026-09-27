/**
 * SimulateButton — simulate a contract call and optionally sign + submit.
 *
 * Uses useWallet (issue #914) so any connected wallet can sign.
 */
import { useState } from 'react';
import { useWallet } from '../hooks/useWallet';

interface SimResult {
  success: boolean;
  returnValue?: string;
  cost?: { cpuInsns: string; memBytes: string };
  resourceFee?: string;
  authEntries?: string[];
  stateChanges?: string[];
  unsignedXdr?: string;
  error?: string;
}

interface Props {
  contractId: string;
  fnName: string;
  args?: string; // JSON array string
  /** When true, enables the sign-and-submit flow (write mode). */
  writeMode?: boolean;
}

export default function SimulateButton({ contractId, fnName, args = '[]', writeMode = false }: Props) {
  const { connected, publicKey, canSignAuthEntries, signTransaction } = useWallet();

  const [result, setResult] = useState<SimResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [argsInput, setArgsInput] = useState(args);
  const [confirmed, setConfirmed] = useState(false);

  async function simulate() {
    setLoading(true);
    setResult(null);
    setConfirmed(false);
    setTxHash(null);
    try {
      const res = await fetch('/api/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contractId,
          fn: fnName,
          args: JSON.parse(argsInput),
          sender: publicKey ?? undefined,
        }),
      });
      const data: SimResult = await res.json();
      setResult(data);
    } catch (e: unknown) {
      setResult({ success: false, error: e instanceof Error ? e.message : 'Simulation failed' });
    } finally {
      setLoading(false);
    }
  }

  async function submit() {
    if (!result?.unsignedXdr || !connected) return;
    setSubmitting(true);
    try {
      const signedXdr = await signTransaction(result.unsignedXdr);
      const res = await fetch('/api/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ xdr: signedXdr }),
      });
      const data = await res.json();
      setTxHash(data.hash ?? null);
    } catch (e: unknown) {
      setResult((r) => r ? { ...r, error: e instanceof Error ? e.message : 'Submit failed' } : r);
    } finally {
      setSubmitting(false);
    }
  }

  const requiresAuth = (result?.authEntries?.length ?? 0) > 0;
  const otherAuthNeeded = requiresAuth && !canSignAuthEntries;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          value={argsInput}
          onChange={(e) => setArgsInput(e.target.value)}
          placeholder='Args JSON, e.g. ["GABC...", 100]'
          style={{ flex: 1, minWidth: 200 }}
        />
        <button
          onClick={simulate}
          disabled={loading}
          style={{ background: 'var(--yellow)', color: '#0d1117' }}
        >
          {loading ? 'Simulating…' : '⚡ Simulate Call'}
        </button>
      </div>

      {result && (
        <div
          className="card"
          style={{ borderColor: result.success ? 'var(--green)' : '#f85149', padding: '12px 16px' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span style={{ fontWeight: 700, color: result.success ? 'var(--green)' : '#f85149' }}>
              {result.success ? '✓ Would succeed' : '✗ Would revert'}
            </span>
            {result.returnValue && (
              <code style={{ color: 'var(--muted)', fontSize: 12 }}>→ {result.returnValue}</code>
            )}
          </div>
          {result.error && <p style={{ color: '#f85149', fontSize: 12, margin: '4px 0' }}>{result.error}</p>}
          {result.cost && (
            <div style={{ display: 'flex', gap: 16, fontSize: 12, color: 'var(--muted)' }}>
              <span>CPU: <strong style={{ color: 'var(--text)' }}>{result.cost.cpuInsns}</strong> insns</span>
              <span>Mem: <strong style={{ color: 'var(--text)' }}>{result.cost.memBytes}</strong> bytes</span>
              {result.resourceFee && (
                <span>Fee: <strong style={{ color: 'var(--text)' }}>{result.resourceFee}</strong> stroops</span>
              )}
            </div>
          )}
          {result.stateChanges && result.stateChanges.length > 0 && (
            <details style={{ marginTop: 8, fontSize: 12 }}>
              <summary style={{ cursor: 'pointer', color: 'var(--muted)' }}>
                State changes ({result.stateChanges.length})
              </summary>
              <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                {result.stateChanges.map((c, i) => <li key={i}>{c}</li>)}
              </ul>
            </details>
          )}

          {/* Write flow: confirm step — never auto-submits */}
          {writeMode && result.success && result.unsignedXdr && (
            <div style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
              {!connected && (
                <p style={{ fontSize: 12, color: 'var(--muted)' }}>
                  Connect a wallet to sign and submit this transaction.
                </p>
              )}
              {otherAuthNeeded && (
                <p style={{ fontSize: 12, color: '#f59e0b' }}>
                  ⚠ This call requires auth entries from additional addresses.
                  Your wallet cannot sign them — the call will be blocked on-chain.
                </p>
              )}
              {connected && !otherAuthNeeded && !confirmed && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0 }}>
                    Review the simulation above, then confirm to sign and submit.
                  </p>
                  <button
                    onClick={() => setConfirmed(true)}
                    style={{ background: 'var(--accent)', color: '#0d1117', padding: '6px 14px', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
                  >
                    Confirm &amp; Sign
                  </button>
                </div>
              )}
              {confirmed && !txHash && (
                <button
                  onClick={submit}
                  disabled={submitting}
                  style={{ background: '#10b981', color: '#0d1117', padding: '6px 14px', border: 'none', borderRadius: 6, cursor: submitting ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 600 }}
                >
                  {submitting ? 'Submitting…' : '🚀 Submit Transaction'}
                </button>
              )}
              {txHash && (
                <p style={{ fontSize: 12, margin: 0 }}>
                  ✓ Submitted:{' '}
                  <a href={`/tx/${txHash}`} style={{ color: 'var(--accent)', fontFamily: 'monospace' }}>
                    {txHash.slice(0, 12)}…
                  </a>
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
