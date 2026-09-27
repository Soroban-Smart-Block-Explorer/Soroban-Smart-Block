/**
 * TypedInput — renders the appropriate HTML input for a ScVal parameter kind.
 *
 * Supports: Address, i128, u128, u32, i32, u64, i64, String, Bool, Bytes,
 * BytesN, Symbol, and Vec (newline-separated entries).
 *
 * Issue #913 — typed input forms.
 */
import { useId } from 'react';

export interface ParamDef {
  name: string;
  kind: string;
}

interface Props {
  param: ParamDef;
  value: string;
  onChange: (value: string) => void;
}

function isAddressKind(kind: string) {
  return kind.toLowerCase() === 'address';
}
function isIntKind(kind: string) {
  return /^[iu](8|16|32|64|128)$/.test(kind.toLowerCase());
}
function isBoolKind(kind: string) {
  return kind.toLowerCase() === 'bool';
}
function isBytesKind(kind: string) {
  return kind.toLowerCase().startsWith('bytes');
}
function isVecKind(kind: string) {
  return kind.toLowerCase().startsWith('vec');
}

export default function TypedInput({ param, value, onChange }: Props) {
  const inputId = useId();
  const { kind } = param;

  const labelStyle: React.CSSProperties = {
    fontSize: 12,
    color: 'var(--muted)',
    fontFamily: 'monospace',
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    boxSizing: 'border-box',
    fontFamily: 'monospace',
    fontSize: 13,
  };

  let input: React.ReactNode;

  if (isBoolKind(kind)) {
    input = (
      <select id={inputId} value={value} onChange={(e) => onChange(e.target.value)} style={inputStyle}>
        <option value="">— select —</option>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  } else if (isAddressKind(kind)) {
    input = (
      <input
        id={inputId}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="G… or C… Stellar address"
        pattern="^[GMC][A-Z2-7]{55,}$"
        style={inputStyle}
        spellCheck={false}
        autoComplete="off"
      />
    );
  } else if (isIntKind(kind)) {
    const isSigned = kind.startsWith('i');
    const placeholder = isSigned
      ? kind === 'i128' || kind === 'i64'
        ? '0 (large signed integer)'
        : '0'
      : '0 (positive integer)';
    input = (
      <input
        id={inputId}
        type="text"
        inputMode="numeric"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        pattern={isSigned ? '^-?[0-9]+$' : '^[0-9]+$'}
        style={inputStyle}
      />
    );
  } else if (isBytesKind(kind)) {
    input = (
      <input
        id={inputId}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="hex or base64 encoded bytes"
        style={{ ...inputStyle, letterSpacing: '0.04em' }}
        spellCheck={false}
        autoComplete="off"
      />
    );
  } else if (isVecKind(kind)) {
    input = (
      <textarea
        id={inputId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="One entry per line"
        rows={3}
        style={{ ...inputStyle, resize: 'vertical' }}
      />
    );
  } else {
    // Default: string / symbol / map / option / etc.
    input = (
      <input
        id={inputId}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={`${kind} value`}
        style={inputStyle}
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label htmlFor={inputId} style={labelStyle}>
        {param.name}
        <span style={{ color: 'var(--accent)', marginLeft: 4 }}>{kind}</span>
      </label>
      {input}
    </div>
  );
}
