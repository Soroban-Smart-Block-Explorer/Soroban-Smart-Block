// Syntax-highlighted Rust source viewer (no external deps, XSS-safe)

interface Props {
  source: string;
  filename?: string;
}

// Escape HTML to prevent XSS
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Token types and their colours (matches project CSS vars)
const RULES: [RegExp, string][] = [
  [/\/\/[^\n]*/g, "#8b949e"], // line comment
  [/\/\*[\s\S]*?\*\//g, "#8b949e"], // block comment
  [/"(?:[^"\\]|\\.)*"/g, "#a5d6ff"], // string literal
  [
    /\b(pub|fn|let|mut|struct|enum|impl|trait|use|mod|self|super|crate|return|if|else|match|for|while|loop|in|as|type|where|const|static|unsafe|async|await|dyn|ref|move|extern|true|false)\b/g,
    "#ff7b72",
  ], // keywords
  [
    /\b(u8|u16|u32|u64|u128|i8|i16|i32|i64|i128|f32|f64|usize|isize|bool|char|str|String|Vec|Option|Result|Self)\b/g,
    "#ffa657",
  ], // types
  [/\b\d+(?:\.\d+)?\b/g, "#79c0ff"], // numbers
  [/#\[[\s\S]*?\]/g, "#d2a8ff"], // attributes
];

function highlight(raw: string): string {
  const escaped = escapeHtml(raw);
  // We work on the escaped string, replacing tokens with <span> tags.
  // To avoid double-replacing, we use a placeholder strategy.
  const placeholders: string[] = [];

  let result = escaped;
  for (const [re, color] of RULES) {
    result = result.replace(re, (match) => {
      const idx = placeholders.length;
      placeholders.push(`<span style="color:${color}">${match}</span>`);
      return `\x00${idx}\x00`;
    });
  }

  // Restore placeholders
  // eslint-disable-next-line no-control-regex
  result = result.replace(/\x00(\d+)\x00/gu, (_, i) => placeholders[Number(i)]);
  return result;
}

export default function RustCodeViewer({ source, filename }: Props) {
  const lines = highlight(source).split("\n");

  return (
    <div className="card" style={{ padding: 0, overflow: "hidden" }}>
      {filename && (
        <div
          style={{
            padding: "8px 16px",
            borderBottom: "1px solid var(--border)",
            color: "var(--muted)",
            fontSize: 12,
            fontFamily: "monospace",
          }}
        >
          📄 {filename}
        </div>
      )}
      <div style={{ overflowX: "auto" }}>
        <table
          style={{
            borderCollapse: "collapse",
            width: "100%",
            fontFamily: "monospace",
            fontSize: 13,
          }}
        >
          <tbody>
            {lines.map((line, i) => (
              <tr key={i} style={{ lineHeight: 1.6 }}>
                <td
                  style={{
                    padding: "0 12px",
                    color: "var(--muted)",
                    userSelect: "none",
                    textAlign: "right",
                    minWidth: 40,
                    borderRight: "1px solid var(--border)",
                    background: "var(--bg)",
                  }}
                >
                  {i + 1}
                </td>
                <td
                  style={{
                    padding: "0 16px",
                    whiteSpace: "pre",
                    color: "var(--text)",
                  }}
                  dangerouslySetInnerHTML={{ __html: line || " " }}
                />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
