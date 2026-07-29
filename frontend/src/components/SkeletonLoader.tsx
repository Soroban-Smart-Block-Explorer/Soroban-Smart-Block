import React from "react";

interface SkeletonLoaderProps {
  rowCount?: number;
}

/**
 * Skeleton loader for EventTable during initial API fetch.
 * Renders placeholder rows with a shimmer animation.
 * Each row matches the column layout: Seq, Ledger, Contract, Function, Description.
 */
export default function SkeletonLoader({ rowCount = 10 }: SkeletonLoaderProps) {
  const skeletonStyle: React.CSSProperties = {
    background: "linear-gradient(90deg, var(--border) 25%, rgba(255,255,255,0.1) 50%, var(--border) 75%)",
    backgroundSize: "200% 100%",
    animation: "shimmer 2s infinite",
    borderRadius: "4px",
    height: "1em",
    width: "100%",
  };

  return (
    <>
      <style>{`
        @keyframes shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}</style>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr
              style={{
                borderBottom: "1px solid var(--border)",
                color: "var(--muted)",
              }}
            >
              <th style={th}>Seq</th>
              <th style={th}>Ledger</th>
              <th style={th}>Contract</th>
              <th style={th}>Function</th>
              <th style={th}>Description</th>
            </tr>
          </thead>
        </table>

        {/* Placeholder rows */}
        <div style={{ overflowY: "auto", maxHeight: 600, position: "relative" }}>
          {Array.from({ length: rowCount }).map((_, index) => (
            <div
              key={index}
              style={{
                borderBottom: "1px solid var(--border)",
                padding: "10px 0",
              }}
            >
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  tableLayout: "fixed",
                }}
              >
                <tbody>
                  <tr>
                    <td style={td}>
                      <div style={{ ...skeletonStyle, width: "40px" }} />
                    </td>
                    <td style={td}>
                      <div style={{ ...skeletonStyle, width: "80px" }} />
                    </td>
                    <td style={td}>
                      <div style={{ ...skeletonStyle, width: "120px" }} />
                    </td>
                    <td style={td}>
                      <div style={{ ...skeletonStyle, width: "100px" }} />
                    </td>
                    <td
                      style={{
                        ...td,
                        maxWidth: 480,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      <div style={{ ...skeletonStyle, width: "85%" }} />
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

const th: React.CSSProperties = {
  textAlign: "left",
  padding: "8px 12px",
  fontWeight: 500,
};

const td: React.CSSProperties = { padding: "10px 12px" };
