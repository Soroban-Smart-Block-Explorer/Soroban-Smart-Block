import { memo } from "react";

interface Props {
  label: string;
  values: (number | null)[];
  format?: (v: number) => string;
}

// Lightweight SVG line chart; memoised so only charts whose series changed re-render.
function NetworkMetricChart({ label, values, format = (v) => v.toFixed(2) }: Props) {
  const nums = values.map((v) => v ?? 0);
  const max = Math.max(...nums, 1e-9);
  const w = 300;
  const h = 60;
  const pts = nums.map((v, i) => `${(i / Math.max(nums.length - 1, 1)) * w},${h - (v / max) * h}`).join(" ");
  const latest = values[values.length - 1];
  return (
    <figure style={{ margin: 0, padding: 12, border: "1px solid var(--border)", borderRadius: 8 }}>
      <figcaption style={{ fontSize: 13, color: "var(--muted)", display: "flex", justifyContent: "space-between" }}>
        <span>{label}</span>
        <strong style={{ color: "var(--text)" }}>{latest == null ? "—" : format(latest)}</strong>
      </figcaption>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} role="img" aria-label={label} preserveAspectRatio="none">
        {nums.length > 1 && <polyline points={pts} fill="none" stroke="var(--accent)" strokeWidth={1.5} />}
      </svg>
    </figure>
  );
}

export default memo(NetworkMetricChart);
