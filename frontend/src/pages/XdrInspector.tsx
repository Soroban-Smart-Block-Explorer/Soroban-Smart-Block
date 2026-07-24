import { useState } from "react";
import { xdr, StrKey } from "@stellar/stellar-sdk";

type TreeNode = string | { [key: string]: TreeNode } | TreeNode[];

function scValToTree(val: xdr.ScVal): TreeNode {
  const type = val.switch().name;
  switch (val.switch()) {
    case xdr.ScValType.scvBool():
      return { bool: String(val.b()) };
    case xdr.ScValType.scvVoid():
      return "void";
    case xdr.ScValType.scvU32():
      return { u32: String(val.u32()) };
    case xdr.ScValType.scvI32():
      return { i32: String(val.i32()) };
    case xdr.ScValType.scvU64():
      return { u64: String(val.u64()) };
    case xdr.ScValType.scvI64():
      return { i64: String(val.i64()) };
    case xdr.ScValType.scvU128(): {
      const u = val.u128();
      return {
        u128: String((BigInt(u.hi().toString()) << 64n) | BigInt(u.lo().toString())),
      };
    }
    case xdr.ScValType.scvI128(): {
      const i = val.i128();
      return {
        i128: String((BigInt(i.hi().toString()) << 64n) | BigInt(i.lo().toString())),
      };
    }
    case xdr.ScValType.scvBytes():
      return { bytes: val.bytes().toString("hex") };
    case xdr.ScValType.scvString():
      return { string: val.str().toString() };
    case xdr.ScValType.scvSymbol():
      return { symbol: val.sym().toString() };
    case xdr.ScValType.scvAddress():
      return { address: val.address().toString() };
    case xdr.ScValType.scvVec(): {
      const items = val.vec();
      return { vec: items ? items.map(scValToTree) : [] };
    }
    case xdr.ScValType.scvMap(): {
      const entries = val.map();
      if (!entries) return { map: {} };
      const obj: Record<string, TreeNode> = {};
      entries.forEach((e) => {
        obj[JSON.stringify(scValToTree(e.key()))] = scValToTree(e.val());
      });
      return { map: obj };
    }
    case xdr.ScValType.scvContractInstance():
      return { contractInstance: "…" };
    case xdr.ScValType.scvLedgerKeyContractInstance():
      return "ledgerKeyContractInstance";
    case xdr.ScValType.scvLedgerKeyNonce():
      return { ledgerKeyNonce: String(val.nonceKey()?.nonce()) };
    default:
      return { [type]: "…" };
  }
}

function muxedToGAddress(ma: xdr.MuxedAccount): string {
  try {
    if (ma.switch() === xdr.CryptoKeyType.keyTypeMuxedEd25519()) {
      return StrKey.encodeEd25519PublicKey(ma.med25519().ed25519());
    }
    return StrKey.encodeEd25519PublicKey(ma.ed25519());
  } catch {
    return "unknown";
  }
}

function tryDecode(b64: string): { tree: TreeNode; label: string } | { error: string } {
  const trimmed = b64.trim();
  if (!trimmed) return { error: "Paste a Base64 XDR string above." };

  const decoders: Array<{ label: string; fn: () => TreeNode }> = [
    {
      label: "TransactionEnvelope",
      fn: () => {
        const env = xdr.TransactionEnvelope.fromXDR(trimmed, "base64");
        if (env.switch() === xdr.EnvelopeType.envelopeTypeTxFeeBump()) {
          const fbTx = env.feeBump().tx();
          const sponsor = muxedToGAddress(fbTx.feeSource());
          const innerTx = fbTx.innerTx().v1().tx();
          const channel_account = muxedToGAddress(innerTx.sourceAccount());
          const ops = innerTx.operations() ?? [];

          // Extract actual_caller from ContractAuth credentials
          let actual_caller: string | null = null;
          try {
            outer: for (const op of ops) {
              const body = op.body();
              if (body.switch().name !== "invokeHostFunction") continue;
              const auths = (body as any).invokeHostFunction().auth() ?? [];
              for (const authEntry of auths) {
                const creds = authEntry.credentials();
                if (creds.switch().name === "sorobanCredentialsSourceAccount") continue;
                try {
                  const scAddr = creds.address().address();
                  const addrType = scAddr.switch().name;
                  if (addrType === "scAddressTypeAccount") {
                    actual_caller = StrKey.encodeEd25519PublicKey(scAddr.accountId().ed25519());
                    break outer;
                  }
                  if (addrType === "scAddressTypeContract") {
                    actual_caller = StrKey.encodeContract(scAddr.contractId());
                    break outer;
                  }
                } catch {
                  /* skip */
                }
              }
            }
          } catch {
            /* leave null */
          }

          const chain_of_custody: Record<string, string> = {
            "Tier 1 — Sponsor Wallet (pays fee)": sponsor,
            "Tier 2 — Channel Account (sequence)": channel_account,
          };
          if (actual_caller) chain_of_custody["Tier 3 — Actual Caller (contract logic)"] = actual_caller;

          return {
            type: "FeeBumpTransactionEnvelope",
            chain_of_custody,
            inner_operations: ops.map((op: xdr.Operation) => {
              const body = op.body();
              const name = body.switch().name;
              if (name === "invokeHostFunction") {
                const hf = (body as any).invokeHostFunction().hostFunction();
                if (hf.switch() === xdr.HostFunctionType.hostFunctionTypeInvokeContract()) {
                  const inv = hf.invokeContract();
                  return {
                    operation: "invokeHostFunction",
                    contract: inv.contractAddress().toString(),
                    function: inv.functionName().toString(),
                    args: inv.args().map(scValToTree),
                  };
                }
              }
              return { operation: name };
            }),
          } as TreeNode;
        }
        const tx = env.value().tx ? env.value().tx() : (env as any).v0?.().tx?.();
        const ops = (tx as any).operations?.() ?? [];
        return {
          type: "TransactionEnvelope",
          operations: ops.map((op: xdr.Operation) => {
            const body = op.body();
            const name = body.switch().name;
            if (name === "invokeHostFunction") {
              const hf = (body as any).invokeHostFunction().hostFunction();
              if (hf.switch() === xdr.HostFunctionType.hostFunctionTypeInvokeContract()) {
                const inv = hf.invokeContract();
                return {
                  operation: "invokeHostFunction",
                  contract: inv.contractAddress().toString(),
                  function: inv.functionName().toString(),
                  args: inv.args().map(scValToTree),
                };
              }
            }
            return { operation: name };
          }),
        } as TreeNode;
      },
    },
    {
      label: "ScVal",
      fn: () => scValToTree(xdr.ScVal.fromXDR(trimmed, "base64")),
    },
    {
      label: "OperationResult",
      fn: () => {
        const r = xdr.OperationResult.fromXDR(trimmed, "base64");
        return { operationResult: r.switch().name };
      },
    },
    {
      label: "TransactionResult",
      fn: () => {
        const r = xdr.TransactionResult.fromXDR(trimmed, "base64");
        return {
          result: r.result().switch().name,
          feeCharged: String(r.feeCharged()),
        };
      },
    },
  ];

  for (const d of decoders) {
    try {
      return { tree: d.fn(), label: d.label };
    } catch {
      /* try next */
    }
  }
  return {
    error: "Could not decode XDR. Ensure it is a valid Base64-encoded Soroban XDR string.",
  };
}

// Color map for known type keys
const KEY_COLORS: Record<string, string> = {
  bool: "#d29922",
  u32: "#58a6ff",
  i32: "#58a6ff",
  u64: "#58a6ff",
  i64: "#58a6ff",
  u128: "#58a6ff",
  i128: "#58a6ff",
  bytes: "#8b949e",
  string: "#3fb950",
  symbol: "#3fb950",
  address: "#e8a44a",
  vec: "#c9d1d9",
  map: "#c9d1d9",
  type: "#d29922",
  operation: "#d29922",
  contract: "#e8a44a",
  function: "#3fb950",
  args: "#c9d1d9",
};

function valueColor(key: string): string {
  return KEY_COLORS[key] ?? "var(--text)";
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <button
      onClick={copy}
      title="Copy value"
      style={{
        background: "none",
        color: copied ? "var(--green)" : "var(--muted)",
        padding: "0 4px",
        fontSize: 11,
        fontWeight: 400,
        marginLeft: 4,
        border: "1px solid var(--border)",
        borderRadius: 4,
      }}
    >
      {copied ? "✓" : "⎘"}
    </button>
  );
}

function TreeView({ node, depth = 0 }: { node: TreeNode; depth?: number }) {
  const [collapsed, setCollapsed] = useState(false);
  const indent = depth * 16;

  if (typeof node === "string") {
    return (
      <span>
        <span style={{ color: "var(--green)" }}>{node}</span>
        <CopyButton value={node} />
      </span>
    );
  }

  if (Array.isArray(node)) {
    if (node.length === 0) return <span style={{ color: "var(--muted)" }}>[]</span>;
    return (
      <span>
        <button
          onClick={() => setCollapsed((c) => !c)}
          style={{
            background: "none",
            color: "var(--accent)",
            padding: "0 4px",
            fontSize: 12,
            fontWeight: 400,
          }}
        >
          {collapsed ? "▶" : "▼"} [{node.length}]
        </button>
        {!collapsed && (
          <div style={{ marginLeft: indent + 16 }}>
            {node.map((item, i) => (
              <div key={i} style={{ marginTop: 2 }}>
                <span style={{ color: "var(--muted)", fontSize: 11 }}>[{i}] </span>
                <TreeView node={item} depth={depth + 1} />
              </div>
            ))}
          </div>
        )}
      </span>
    );
  }

  const entries = Object.entries(node);
  return (
    <div>
      {entries.map(([k, v]) => {
        const isLeaf = typeof v === "string";
        return (
          <div key={k} style={{ marginTop: 4, marginLeft: indent }}>
            <span style={{ color: "var(--accent)", fontWeight: 600 }}>{k}: </span>
            {isLeaf ? (
              <span>
                <span style={{ color: valueColor(k) }}>{v}</span>
                <CopyButton value={v} />
              </span>
            ) : (
              <TreeView node={v} depth={depth + 1} />
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function XdrInspector() {
  const [input, setInput] = useState("");
  const decoded = tryDecode(input);

  const copyAll = () => {
    if (decoded && !("error" in decoded)) {
      navigator.clipboard.writeText(JSON.stringify(decoded.tree, null, 2));
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div className="card">
        <h2 style={{ marginBottom: 8 }}>XDR-to-JSON Workbench</h2>
        <p style={{ color: "var(--muted)", marginBottom: 12, fontSize: 13 }}>
          Paste a raw Base64-encoded Soroban XDR string to instantly view a decoded, color-coded JSON tree.
        </p>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Paste Base64 XDR here…"
          rows={4}
          style={{
            width: "100%",
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            color: "var(--text)",
            padding: "8px 10px",
            fontSize: 12,
            fontFamily: "monospace",
            resize: "vertical",
          }}
        />
      </div>

      {decoded && (
        <div className="card">
          {"error" in decoded ? (
            <p style={{ color: "#f85149", fontSize: 13 }}>{decoded.error}</p>
          ) : (
            <>
              <div
                style={{
                  marginBottom: 12,
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span className="badge">{decoded.label}</span>
                <span style={{ color: "var(--muted)", fontSize: 12 }}>decoded successfully</span>
                <button
                  onClick={copyAll}
                  style={{
                    marginLeft: "auto",
                    background: "var(--border)",
                    color: "var(--text)",
                    fontSize: 12,
                    padding: "4px 12px",
                  }}
                >
                  Copy JSON
                </button>
              </div>
              <div
                style={{
                  fontFamily: "monospace",
                  fontSize: 13,
                  lineHeight: 1.6,
                }}
              >
                <TreeView node={decoded.tree} />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
