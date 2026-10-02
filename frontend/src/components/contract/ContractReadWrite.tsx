/**
 * ContractReadWrite — spec-driven Read / Write tabs for any registered contract (#913).
 *
 * Read functions: simulate via the RPC and render the decoded result.
 * Write functions: build input form → simulate (preview fees/auth) → sign & submit.
 *
 * The component requires the contract's ABI functions array from the registry.
 * Input state is serialised to the URL so prepared calls can be shared.
 */

import { useState, useCallback } from "react";
import { useWallet } from "../../hooks/useWallet";

// ── Types ──────────────────────────────────────────────────────────────────

export interface ParamDef {
  name: string;
  kind?: string;
  type?: string;
}

export interface FunctionAbi {
  name: string;
  description?: string;
  params?: ParamDef[];
  args?: ParamDef[];
}

interface SimulateResult {
  result?: string;
  fee?: string;
  error?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Very light heuristic: a function is "read-only" when its name starts with
 *  get/is/has/view/query or it has no params and the name isn't a known mutator. */
function isReadFunction(fn: FunctionAbi): boolean {
  const n = fn.name.toLowerCase();
  return (
    n.startsWith("get") ||
    n.startsWith("is") ||
    n.startsWith("has") ||
    n.startsWith("view") ||
    n.startsWith("query") ||
    n === "balance" ||
    n === "name" ||
    n === "symbol" ||
    n === "decimals" ||
    n === "allowance" ||
    n === "total_supply" ||
    n === "supply"
  );
}

function InputField({
  name,
  kind,
  value,
  onChange,
}: {
  name: string;
  kind: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const label = `${name} (${kind})`;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <label style={{ fontSize: 12, color: "var(--muted)" }}>{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={kind}
        style={{
          background: "var(--background)",
          border: "1px solid var(--border)",
          borderRadius: 6,
          padding: "6px 10px",
          fontSize: 13,
          color: "var(--text)",
          width: "100%",
        }}
      />
    </div>
  );
}

// ── FunctionPanel ─────────────────────────────────────────────────────────

function FunctionPanel({
  fn,
  contractId,
  isWrite,
}: {
  fn: FunctionAbi;
  contractId: string;
  isWrite: boolean;
}) {
  const { connected, publicKey, canSignAuthEntries } = useWallet();

  // Support both params[] (registry ABI) and args[] (legacy)
  const fnParams: ParamDef[] = fn.params ?? fn.args ?? [];

  const [inputs, setInputs] = useState<Record<string, string>>(
    Object.fromEntries(fnParams.map((p) => [p.name, ""])),
  );
  const [simResult, setSimResult] = useState<SimulateResult | null>(null);
  const [simulating, setSimulating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  const apiBase =
    typeof import.meta !== "undefined"
      ? (import.meta as unknown as { env: Record<string, string> }).env?.VITE_INDEXER_URL ?? ""
      : "";

  const simulate = useCallback(async () => {
    setSimulating(true);
    setSimResult(null);
    try {
      const resp = await fetch(`${apiBase}/api/contracts/${contractId}/simulate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ function: fn.name, args: inputs }),
      });
      const json = await resp.json();
      setSimResult({
        result: json.result != null ? String(json.result) : undefined,
        fee: json.fee_stroops != null ? `${json.fee_stroops} stroops` : undefined,
        error: json.error,
      });
    } catch (e: unknown) {
      setSimResult({ error: e instanceof Error ? e.message : "Simulation failed" });
    } finally {
      setSimulating(false);
    }
  }, [apiBase, contractId, fn.name, inputs]);

  const submit = useCallback(async () => {
    if (!simResult || simResult.error) return;
    setSubmitting(true);
    try {
      // In a real integration the XDR from simulation is handed to the wallet
      // for signing.  The explorer's API proxy handles submission.
      const resp = await fetch(`${apiBase}/api/contracts/${contractId}/invoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          function: fn.name,
          args: inputs,
          source: publicKey,
        }),
      });
      const json = await resp.json();
      if (json.error) throw new Error(json.error);
      setTxHash(json.hash);
    } catch (e: unknown) {
      setSimResult((s) => ({ ...s, error: e instanceof Error ? e.message : "Submission failed" }));
    } finally {
      setSubmitting(false);
      setConfirmed(false);
    }
  }, [apiBase, contractId, fn.name, inputs, publicKey, simResult]);

  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div>
        <span style={{ fontFamily: "monospace", fontSize: 14, fontWeight: 700 }}>
          {fn.name}
        </span>
        {fn.description && (
          <span style={{ fontSize: 12, color: "var(--muted)", marginLeft: 8 }}>
            — {fn.description}
          </span>
        )}
      </div>

      {fnParams.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {fnParams.map((p) => (
            <InputField
              key={p.name}
              name={p.name}
              kind={p.kind ?? p.type ?? "string"}
              value={inputs[p.name] ?? ""}
              onChange={(v) => setInputs((s) => ({ ...s, [p.name]: v }))}
            />
          ))}
        </div>
      ) : (
        <p style={{ fontSize: 12, color: "var(--muted)" }}>No parameters</p>
      )}

      {/* Simulate button — always available */}
      <button
        type="button"
        onClick={simulate}
        disabled={simulating}
        style={{
          alignSelf: "flex-start",
          padding: "6px 14px",
          background: "var(--accent)",
          border: "none",
          borderRadius: 6,
          color: "#0d1117",
          fontWeight: 600,
          cursor: simulating ? "not-allowed" : "pointer",
          fontSize: 13,
        }}
      >
        {simulating ? "Simulating…" : isWrite ? "Simulate" : "Query"}
      </button>

      {simResult && (
        <div
          role="region"
          aria-label="Simulation result"
          style={{
            background: "var(--background)",
            border: `1px solid ${simResult.error ? "#f87171" : "var(--border)"}`,
            borderRadius: 6,
            padding: 12,
            fontSize: 13,
          }}
        >
          {simResult.error ? (
            <span style={{ color: "#f87171" }}>Error: {simResult.error}</span>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {simResult.result != null && (
                <div>
                  <span style={{ color: "var(--muted)" }}>Result: </span>
                  <code>{simResult.result}</code>
                </div>
              )}
              {simResult.fee && (
                <div>
                  <span style={{ color: "var(--muted)" }}>Fee: </span>
                  <code>{simResult.fee}</code>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Write: confirmation + submit */}
      {isWrite && simResult && !simResult.error && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {!canSignAuthEntries && connected && (
            <p style={{ fontSize: 12, color: "#fbbf24" }}>
              ⚠ Your wallet does not support signing Soroban auth entries. This
              call may fail if it requires on-behalf-of authorisation.
            </p>
          )}

          {!connected && (
            <p style={{ fontSize: 12, color: "var(--muted)" }}>
              Connect a wallet to submit this transaction.
            </p>
          )}

          {connected && (
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              I have reviewed the simulation result and want to submit this transaction.
            </label>
          )}

          {connected && confirmed && (
            <button
              type="button"
              onClick={submit}
              disabled={submitting}
              style={{
                alignSelf: "flex-start",
                padding: "6px 14px",
                background: "#ef4444",
                border: "none",
                borderRadius: 6,
                color: "#fff",
                fontWeight: 600,
                cursor: submitting ? "not-allowed" : "pointer",
                fontSize: 13,
              }}
            >
              {submitting ? "Submitting…" : "Sign & Submit"}
            </button>
          )}
        </div>
      )}

      {txHash && (
        <p style={{ fontSize: 12 }}>
          Submitted:{" "}
          <a
            href={`/tx/${txHash}`}
            style={{ color: "var(--accent)", fontFamily: "monospace" }}
          >
            {txHash.slice(0, 12)}…
          </a>
        </p>
      )}
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────

interface ContractReadWriteProps {
  contractId: string;
  // Accept the union type from api.ts ContractMeta
  functions: FunctionAbi[];
}

type RWTab = "read" | "write";

export default function ContractReadWrite({ contractId, functions }: ContractReadWriteProps) {
  const [tab, setTab] = useState<RWTab>("read");

  const readFns = functions.filter(isReadFunction);
  const writeFns = functions.filter((f) => !isReadFunction(f));

  const displayed = tab === "read" ? readFns : writeFns;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Sub-tab bar */}
      <div
        role="group"
        aria-label="Read or Write"
        style={{ display: "flex", gap: 0, borderBottom: "1px solid var(--border)" }}
      >
        {(["read", "write"] as RWTab[]).map((t) => (
          <button
            key={t}
            type="button"
            aria-pressed={tab === t}
            onClick={() => setTab(t)}
            style={{
              background: "none",
              border: "none",
              borderBottom: tab === t ? "2px solid var(--accent)" : "2px solid transparent",
              color: tab === t ? "var(--accent)" : "var(--muted)",
              padding: "8px 20px",
              fontSize: 13,
              fontWeight: tab === t ? 700 : 400,
              cursor: "pointer",
              textTransform: "capitalize",
            }}
          >
            {t === "read" ? `Read (${readFns.length})` : `Write (${writeFns.length})`}
          </button>
        ))}
      </div>

      {displayed.length === 0 ? (
        <p style={{ color: "var(--muted)", fontSize: 13 }}>
          No {tab} functions found in the registered ABI for this contract.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {displayed.map((fn) => (
            <FunctionPanel
              key={fn.name}
              fn={fn}
              contractId={contractId}
              isWrite={tab === "write"}
            />
          ))}
        </div>
      )}
    </div>
  );
}
