import { useState } from "react";

interface CopyableAddressProps {
  /** The full untruncated value to copy */
  fullValue: string;
  /** The displayed truncated value */
  displayValue: string;
  /** Optional title attribute */
  title?: string;
}

/**
 * Renders a truncated address/hash with a clipboard icon on hover.
 * Clicking the icon copies the full value and shows a transient "Copied!" tooltip for 2 seconds.
 * Gracefully falls back if Clipboard API is unavailable.
 */
export default function CopyableAddress({ fullValue, displayValue, title }: CopyableAddressProps) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    // Check if Clipboard API is available
    if (!navigator.clipboard) {
      // Fallback: use the old-school method (if Clipboard API unavailable)
      const textarea = document.createElement("textarea");
      textarea.value = fullValue;
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand("copy");
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch (err) {
        console.error("Copy failed:", err);
      }
      document.body.removeChild(textarea);
      return;
    }

    try {
      await navigator.clipboard.writeText(fullValue);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Copy failed:", err);
    }
  }

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        position: "relative",
        whiteSpace: "nowrap",
      }}
      title={title || fullValue}
    >
      <span>{displayValue}</span>
      <button
        onClick={handleCopy}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          padding: "2px 4px",
          marginLeft: "2px",
          color: "var(--muted)",
          fontSize: "12px",
          opacity: 0.6,
          transition: "opacity 200ms ease, color 200ms ease",
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.opacity = "1";
          (e.currentTarget as HTMLButtonElement).style.color = "var(--accent)";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.opacity = "0.6";
          (e.currentTarget as HTMLButtonElement).style.color = "var(--muted)";
        }}
        title="Copy to clipboard"
        aria-label="Copy to clipboard"
      >
        📋
      </button>
      {copied && (
        <span
          style={{
            position: "absolute",
            top: "-24px",
            right: 0,
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "4px",
            padding: "4px 8px",
            fontSize: "12px",
            color: "var(--green)",
            whiteSpace: "nowrap",
            zIndex: 10,
          }}
        >
          Copied!
        </span>
      )}
    </span>
  );
}
