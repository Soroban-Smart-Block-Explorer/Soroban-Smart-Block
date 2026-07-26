/**
 * AbiFunctionTable — Issue #515
 *
 * Dynamic table for defining ABI function signatures.
 * Each row = one function (name, description, param list).
 * Each param row: name + kind dropdown.
 * Keyboard support, live preview, enforces on-chain limits.
 */
import { useCallback, useId } from "react";

export const PARAM_KINDS = [
  "Address",
  "i128",
  "u128",
  "u64",
  "u32",
  "i64",
  "i32",
  "Bool",
  "String",
  "Bytes",
  "Symbol",
] as const;

export type ParamKind = (typeof PARAM_KINDS)[number];

export interface ParamDef {
  name: string;
  kind: ParamKind;
}

export interface FunctionRow {
  id: string; // internal key only
  name: string;
  description: string;
  params: (ParamDef & { id: string })[];
}

const MAX_FUNCTIONS = 50;
const MAX_PARAMS_PER_FN = 20;
const MAX_NAME_LENGTH = 32;

function makeParam(): ParamDef & { id: string } {
  return { id: crypto.randomUUID(), name: "", kind: "Address" };
}

function makeFunction(): FunctionRow {
  return { id: crypto.randomUUID(), name: "", description: "", params: [makeParam()] };
}

// ── Live preview helpers ──────────────────────────────────────────────────────
const SAMPLE_ADDRESSES: Record<string, string> = {
  from: "GA…BCD",
  to: "GB…EFG",
  admin: "GC…HIJ",
};

function sampleValue(param: ParamDef): string {
  const k = param.kind.toLowerCase();
  if (k === "address") return SAMPLE_ADDRESSES[param.name.toLowerCase()] ?? "GA…XYZ";
  if (k === "i128" || k === "u128") return "100";
  if (k === "u64" || k === "u32" || k === "i64" || k === "i32") return "42";
  if (k === "bool") return "true";
  if (k === "string") return `"${param.name}"`;
  if (k === "bytes") return "0xdeadbeef";
  if (k === "symbol") return param.name || "sym";
  return param.name || "…";
}

function buildPreview(fn: FunctionRow): string {
  if (!fn.name) return "";
  const argStr = fn.params
    .filter((p) => p.name)
    .map((p) => `${p.name}=${sampleValue(p)}`)
    .join(", ");
  return `${fn.name}(${argStr})`;
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  value: FunctionRow[];
  onChange: (rows: FunctionRow[]) => void;
}

export function emptyFunctionList(): FunctionRow[] {
  return [makeFunction()];
}

export default function AbiFunctionTable({ value, onChange }: Props) {
  const baseId = useId();
  const atLimit = value.length >= MAX_FUNCTIONS;

  const addFunction = useCallback(() => {
    if (atLimit) return;
    onChange([...value, makeFunction()]);
  }, [value, onChange, atLimit]);

  const removeFunction = useCallback(
    (fnId: string) => {
      onChange(value.filter((f) => f.id !== fnId));
    },
    [value, onChange],
  );

  const updateFunction = useCallback(
    (fnId: string, patch: Partial<Omit<FunctionRow, "id" | "params">>) => {
      onChange(value.map((f) => (f.id === fnId ? { ...f, ...patch } : f)));
    },
    [value, onChange],
  );

  const addParam = useCallback(
    (fnId: string) => {
      onChange(
        value.map((f) => {
          if (f.id !== fnId || f.params.length >= MAX_PARAMS_PER_FN) return f;
          return { ...f, params: [...f.params, makeParam()] };
        }),
      );
    },
    [value, onChange],
  );

  const removeParam = useCallback(
    (fnId: string, paramId: string) => {
      onChange(
        value.map((f) => {
          if (f.id !== fnId) return f;
          return { ...f, params: f.params.filter((p) => p.id !== paramId) };
        }),
      );
    },
    [value, onChange],
  );

  const updateParam = useCallback(
    (fnId: string, paramId: string, patch: Partial<ParamDef>) => {
      onChange(
        value.map((f) => {
          if (f.id !== fnId) return f;
          return {
            ...f,
            params: f.params.map((p) => (p.id === paramId ? { ...p, ...patch } : p)),
          };
        }),
      );
    },
    [value, onChange],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {value.map((fn, fnIdx) => {
        const preview = buildPreview(fn);
        const atParamLimit = fn.params.length >= MAX_PARAMS_PER_FN;

        return (
          <div
            key={fn.id}
            className="card"
            style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}
          >
            {/* Function header */}
            <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
                <label
                  htmlFor={`${baseId}-fn-${fnIdx}-name`}
                  style={{ fontSize: 12, color: "var(--muted)" }}
                >
                  Function name *
                </label>
                <input
                  id={`${baseId}-fn-${fnIdx}-name`}
                  aria-label={`Function ${fnIdx + 1} name`}
                  value={fn.name}
                  maxLength={MAX_NAME_LENGTH}
                  placeholder="e.g. transfer"
                  onChange={(e) => updateFunction(fn.id, { name: e.target.value })}
                  style={{ fontFamily: "monospace" }}
                />
              </div>
              <div style={{ flex: 2, display: "flex", flexDirection: "column", gap: 6 }}>
                <label
                  htmlFor={`${baseId}-fn-${fnIdx}-desc`}
                  style={{ fontSize: 12, color: "var(--muted)" }}
                >
                  Description
                </label>
                <input
                  id={`${baseId}-fn-${fnIdx}-desc`}
                  aria-label={`Function ${fnIdx + 1} description`}
                  value={fn.description}
                  maxLength={512}
                  placeholder="What does this function do?"
                  onChange={(e) => updateFunction(fn.id, { description: e.target.value })}
                />
              </div>
              <button
                type="button"
                aria-label={`Remove function ${fnIdx + 1}`}
                onClick={() => removeFunction(fn.id)}
                style={{ marginTop: 24, padding: "4px 10px", fontSize: 14 }}
              >
                ✕
              </button>
            </div>

            {/* Parameters */}
            <div>
              <p style={{ fontSize: 12, color: "var(--muted)", marginBottom: 6 }}>
                Parameters ({fn.params.length}/{MAX_PARAMS_PER_FN})
              </p>
              {fn.params.length > 0 && (
                <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 6 }}>
                  <thead>
                    <tr style={{ textAlign: "left" }}>
                      <th style={{ padding: "4px 6px", fontSize: 11, color: "var(--muted)" }}>
                        Param name
                      </th>
                      <th style={{ padding: "4px 6px", fontSize: 11, color: "var(--muted)" }}>
                        Type
                      </th>
                      <th style={{ width: 40 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {fn.params.map((param, pIdx) => (
                      <tr key={param.id}>
                        <td style={{ padding: "4px 6px" }}>
                          <input
                            aria-label={`Function ${fnIdx + 1} param ${pIdx + 1} name`}
                            value={param.name}
                            maxLength={MAX_NAME_LENGTH}
                            placeholder="name"
                            style={{ fontFamily: "monospace", width: "100%" }}
                            onChange={(e) =>
                              updateParam(fn.id, param.id, { name: e.target.value })
                            }
                            onKeyDown={(e) => {
                              // Tab from last param name focuses the kind select
                              if (e.key === "Backspace" && param.name === "") {
                                e.preventDefault();
                                removeParam(fn.id, param.id);
                              }
                            }}
                          />
                        </td>
                        <td style={{ padding: "4px 6px" }}>
                          <select
                            aria-label={`Function ${fnIdx + 1} param ${pIdx + 1} type`}
                            value={param.kind}
                            onChange={(e) =>
                              updateParam(fn.id, param.id, { kind: e.target.value as ParamKind })
                            }
                            style={{ width: "100%" }}
                          >
                            {PARAM_KINDS.map((k) => (
                              <option key={k} value={k}>
                                {k}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td style={{ padding: "4px 6px" }}>
                          <button
                            type="button"
                            aria-label={`Remove param ${pIdx + 1} from function ${fnIdx + 1}`}
                            onClick={() => removeParam(fn.id, param.id)}
                            style={{ padding: "2px 8px", fontSize: 13 }}
                          >
                            ✕
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <button
                type="button"
                onClick={() => addParam(fn.id)}
                disabled={atParamLimit}
                style={{ fontSize: 12, padding: "4px 10px" }}
                aria-label={`Add parameter to function ${fnIdx + 1}`}
              >
                + Add param
              </button>
              {atParamLimit && (
                <span style={{ fontSize: 11, color: "#f85149", marginLeft: 8 }}>
                  Max {MAX_PARAMS_PER_FN} params
                </span>
              )}
            </div>

            {/* Live preview */}
            {preview && (
              <div
                style={{
                  background: "var(--surface)",
                  borderRadius: 4,
                  padding: "6px 10px",
                  fontSize: 12,
                  fontFamily: "monospace",
                  color: "var(--muted)",
                  border: "1px solid var(--border)",
                }}
                aria-label="Live function preview"
              >
                <span style={{ color: "var(--muted)", fontSize: 11, marginRight: 8 }}>
                  Preview:
                </span>
                <span style={{ color: "var(--text)" }}>{preview}</span>
              </div>
            )}
          </div>
        );
      })}

      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button
          type="button"
          onClick={addFunction}
          disabled={atLimit}
          aria-label="Add function"
          style={{ padding: "6px 14px" }}
        >
          + Add function
        </button>
        {atLimit && (
          <span style={{ fontSize: 12, color: "#f85149" }}>
            Maximum {MAX_FUNCTIONS} functions reached
          </span>
        )}
      </div>
    </div>
  );
}
