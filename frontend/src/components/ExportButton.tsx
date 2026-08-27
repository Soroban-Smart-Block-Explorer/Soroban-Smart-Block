import { useState, useRef, useEffect } from "react";

type ExportTarget = "events" | "contracts";
type ExportFormat = "csv" | "json" | "ndjson";

interface ExportButtonProps {
  target: ExportTarget;
  params?: Record<string, string | undefined>;
}

export default function ExportButton({ target, params = {} }: ExportButtonProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function close(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  function buildUrl(format: ExportFormat) {
    const q = new URLSearchParams({ format });
    for (const [k, v] of Object.entries(params)) {
      if (v) q.set(k, v);
    }
    return `/api/export/${target}?${q}`;
  }

  function download(format: ExportFormat) {
    setOpen(false);
    const a = document.createElement("a");
    a.href = buildUrl(format);
    const ext = format === "ndjson" ? "ndjson" : format;
    a.download = `${target}.${ext}`;
    a.click();
  }

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}>
      <button
        title="Export data"
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 14px",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 6,
          color: "var(--muted)",
          cursor: "pointer",
          fontSize: 13,
        }}
      >
        ↓ Export
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            right: 0,
            top: "calc(100% + 4px)",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            overflow: "hidden",
            zIndex: 100,
            minWidth: 120,
            boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
          }}
        >
          {(["csv", "json", "ndjson"] as ExportFormat[]).map((fmt) => (
            <button
              key={fmt}
              onClick={() => download(fmt)}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "8px 14px",
                background: "transparent",
                border: "none",
                color: "var(--fg, #e6edf3)",
                cursor: "pointer",
                fontSize: 13,
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--accent-muted, rgba(255,255,255,0.06))")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              {fmt.toUpperCase()}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
