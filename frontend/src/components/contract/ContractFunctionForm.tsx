/**
 * ContractFunctionForm — one expand/collapse panel per ABI function.
 *
 * Read mode:  simulate via /api/simulate and display the result.
 * Write mode: simulate → show fee/auth/state → confirm → sign → submit.
 *
 * Issue #913 constraints:
 *  - Never auto-submit; explicit confirm step shows exactly what will be signed.
 *  - Mainnet writes show an additional warning.
 *  - Input values persist in the URL so a prepared call can be shared.
 *  - Functions requiring auth from other addresses → explain and block.
 *  - Simulation requiring restore → offer the restore flow first.
 */
import { useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useWallet } from '../../hooks/useWallet';
import TypedInput, { type ParamDef } from './TypedInput';

interface FunctionDef {
  name: string;
  description?: string;
  params?: ParamDef[];
  /** 'read' inferred if name starts with get/balance/query/is/has/decimals/symbol/name, else 'write' */
  kind?: 'read' | 'write';
}

interface SimResult {
  success: boolean;
  returnValue?: string;
  cost?: { cpuInsns: string; memBytes: string };
  resourceFee?: string;
  authEntries?: string[];
  stateChanges?: string[];
  requiresRestore?: boolean;
  unsignedXdr?: string;
  error?: string;
}

interface Props {
  contractId: string;
  fn: FunctionDef;
  mode: 'read' | 'write';
  isMainnet?: boolean;
}

const READ_PREFIXES = ['get', 'balance', 'query', 'is', 'has', 'decimals', 'symbol', 'name', 'total_supply', 'allowance'];

function inferKind(name: string): 'read' | 'write' {
  const lower = name.toLowerCase();
  return READ_PREFIXES.some((p) => lower.startsWith(p)) ? 'read' : 'write';
}

/** Build a URL-safe param key: fn_<fnName>_<paramName> */
function urlKey(fnName: string, paramName: string) {
  return `fn_${fnName}_${paramName}`;
}

export default function ContractFunctionForm({ contractId, fn, mode, isMainnet = false }: Props) {
  const [searchParams, setSearchParams] = useSearchParams();
  const { connected, canSignAuthEntries, signTransaction } = useWallet();

  const effectiveKind = fn.kind ?? inferKind(fn.name);
  if (effectiveKind !== mode) return null;

  const params: ParamDef[] = fn.params ?? [];

  // Initialize values from URL params for shareability
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const p of params) {
      initial[p.name] = searchParams.get(urlKey(fn.name, p.name)) ?? '';
    }
    return initial;
  });

  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SimResult | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);

  const setValue = useCallback((name: string, val: string) => {
    setValues((prev) => {
      const next = { ...prev, [name]: val };
      // Persist to URL
      setSearchParams((sp) => {
        const updated = new URLSearchParams(sp);
        updated.set(urlKey(fn.name, name), val);
        return updated;
      }, { replace: true });
      return next;
    });
  }, [fn.name, setSearchParams]);

  async function simulate() {
    setLoading(true);
    setResult(null);
    setConfirmed(false);
    setTxHash(null);
    try {
      const args = params.map((p) => {
        const v = values[p.name] ?? '';
        // Coerce booleans and numbers for JSON
        if (p.kind.toLowerCase() === 'bool') return v === 'true';
        if (/^[iu](8|16|32|64|128)$/.test(p.kind.toLowerCase())) return Number(v);
        return v;
      });
      const res = await fetch('/api/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contractId, fn: fn.name, args }),
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

  const requiresOtherAuth =
    (result?.authEntries?.length ?? 0) > 1 ||
    (!canSignAuthEntries && (result?.authEntries?.length ?? 0) > 0);

  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      {/* Accordion header */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          width: '100%',
          textAlign: 'left',
          background: 'var(--surface)',
          border: 'none',
          padding: '10px 14px',
          cursor: 'pointer',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 8,
        }}
        aria-expanded={open}
      >
        <span>
          <code style={{ fontSize: 13, color: mode === 'read' ? 'var(--green)' : 'var(--accent)', marginRight: 8 }}>
            {fn.name}
          </code>
          {fn.description && (
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>{fn.description}</span>
          )}
        </span>
        <span style={{ color: 'var(--muted)', fontSize: 12 }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div style={{ padding: '14px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Parameter inputs */}
          {params.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {params.map((p) => (
                <TypedInput
                  key={p.name}
                  param={p}
                  value={values[p.name] ?? ''}
                  onChange={(v) => setValue(p.name, v)}
                />
              ))}
            </div>
          ) : (
            <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0 }}>No parameters.</p>
          )}

          <button
            onClick={simulate}
            disabled={loading}
            style={{
              padding: '6px 14px',
              background: 'var(--yellow)',
              border: 'none',
              borderRadius: 6,
              cursor: loading ? 'not-allowed' : 'pointer',
              color: '#0d1117',
              fontSize: 13,
              fontWeight: 600,
              alignSelf: 'flex-start',
            }}
          >
            {loading ? 'Running…' : mode === 'read' ? '▶ Read' : '⚡ Simulate'}
          </button>

          {/* Result panel */}
          {result && (
            <div
              className="card"
              style={{ borderColor: result.success ? 'var(--green)' : '#f85149', padding: '12px 16px' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontWeight: 700, color: result.success ? 'var(--green)' : '#f85149' }}>
                  {result.success ? '✓ Success' : '✗ Would revert'}
                </span>
                {result.returnValue && (
                  <code style={{ color: 'var(--muted)', fontSize: 12 }}>→ {result.returnValue}</code>
                )}
              </div>
              {result.error && <p style={{ color: '#f85149', fontSize: 12, margin: '4px 0 0' }}>{result.error}</p>}

              {result.requiresRestore && (
                <div style={{ marginTop: 8, padding: '8px 12px', background: 'rgba(245,158,11,0.08)', borderRadius: 6, fontSize: 12 }}>
                  ⚠ Some storage entries are archived. Restore them first before this call can succeed.
                </div>
              )}

              {result.cost && (
                <div style={{ display: 'flex', gap: 16, fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
                  <span>CPU: <strong style={{ color: 'var(--text)' }}>{result.cost.cpuInsns}</strong> insns</span>
                  <span>Mem: <strong style={{ color: 'var(--text)' }}>{result.cost.memBytes}</strong> bytes</span>
                  {result.resourceFee && (
                    <span>Fee: <strong style={{ color: 'var(--text)' }}>{result.resourceFee}</strong> stroops</span>
                  )}
                </div>
              )}

              {result.authEntries && result.authEntries.length > 0 && (
                <details style={{ marginTop: 8, fontSize: 12 }}>
                  <summary style={{ cursor: 'pointer', color: 'var(--muted)' }}>
                    Auth entries ({result.authEntries.length})
                  </summary>
                  <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                    {result.authEntries.map((e, i) => <li key={i}><code>{e}</code></li>)}
                  </ul>
                </details>
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

              {/* Write flow — confirmation step (never auto-submits) */}
              {mode === 'write' && result.success && result.unsignedXdr && (
                <div style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
                  {isMainnet && (
                    <div style={{ marginBottom: 8, padding: '8px 12px', background: 'rgba(239,68,68,0.08)', borderRadius: 6, fontSize: 12, color: '#f87171' }}>
                      ⚠ Mainnet: this transaction will broadcast to the live network and cannot be reversed.
                    </div>
                  )}
                  {!connected && (
                    <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0 }}>
                      Connect a wallet to sign and submit this transaction.
                    </p>
                  )}
                  {requiresOtherAuth && (
                    <p style={{ fontSize: 12, color: '#f59e0b', margin: 0 }}>
                      ⚠ This call requires auth from addresses other than the signer.
                      The transaction will be rejected on-chain unless those signers provide entries separately.
                    </p>
                  )}
                  {connected && !requiresOtherAuth && !confirmed && !txHash && (
                    <button
                      onClick={() => setConfirmed(true)}
                      style={{
                        padding: '6px 14px',
                        background: 'var(--accent)',
                        border: 'none',
                        borderRadius: 6,
                        cursor: 'pointer',
                        color: '#0d1117',
                        fontSize: 13,
                        fontWeight: 600,
                      }}
                    >
                      Confirm &amp; Sign
                    </button>
                  )}
                  {confirmed && !txHash && (
                    <button
                      onClick={submit}
                      disabled={submitting}
                      style={{
                        padding: '6px 14px',
                        background: '#10b981',
                        border: 'none',
                        borderRadius: 6,
                        cursor: submitting ? 'not-allowed' : 'pointer',
                        color: '#0d1117',
                        fontSize: 13,
                        fontWeight: 600,
                      }}
                    >
                      {submitting ? 'Submitting…' : '🚀 Submit Transaction'}
                    </button>
                  )}
                  {txHash && (
                    <p style={{ fontSize: 12, margin: 0 }}>
                      ✓ Submitted:{' '}
                      <a href={`/tx/${txHash}`} style={{ color: 'var(--accent)', fontFamily: 'monospace' }}>
                        {txHash.slice(0, 16)}…
                      </a>
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
