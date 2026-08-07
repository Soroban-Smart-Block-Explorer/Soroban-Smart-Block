import type { ContractListItem } from "../api";

type ProtocolType = ContractListItem["protocol_type"];

/** Colour + label for each protocol type (issue #556). */
const PROTOCOL_BADGE_STYLES: Record<string, { label: string; color: string; background: string }> = {
  dex: { label: "DEX", color: "#c4b5fd", background: "rgba(139,92,246,0.18)" },
  lending: { label: "Lending", color: "#fdba74", background: "rgba(249,115,22,0.18)" },
  nft: { label: "NFT", color: "#f9a8d4", background: "rgba(236,72,153,0.18)" },
  token: { label: "Token", color: "#93c5fd", background: "rgba(59,130,246,0.18)" },
  other: { label: "Other", color: "var(--muted)", background: "var(--border)" },
};

/** Coloured protocol-type badge shown on contract cards and next to contract names in the event feed. */
export default function ProtocolBadge({ type }: { type?: ProtocolType | null }) {
  if (!type) return null;
  const style = PROTOCOL_BADGE_STYLES[type] ?? PROTOCOL_BADGE_STYLES.other;

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "2px 8px",
        borderRadius: 10,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: "0.03em",
        textTransform: "uppercase",
        color: style.color,
        background: style.background,
        whiteSpace: "nowrap",
      }}
      title={`Protocol type: ${style.label}`}
    >
      {style.label}
    </span>
  );
}
