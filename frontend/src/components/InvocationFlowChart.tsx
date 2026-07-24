// Cross-contract invocation visual flow chart (pure SVG/CSS, no deps)

export interface InvocationNode {
  contract: string;
  fn: string;
  children?: InvocationNode[];
}

interface Props {
  root: InvocationNode;
}

// Shorten a contract ID for display
function short(id: string) {
  return id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

const NODE_W = 180;
const NODE_H = 52;
const H_GAP = 40; // horizontal gap between levels
const V_GAP = 16; // vertical gap between siblings

// Measure total height needed for a subtree
function treeHeight(node: InvocationNode): number {
  if (!node.children?.length) return NODE_H;
  const childrenH = node.children.reduce((s, c) => s + treeHeight(c) + V_GAP, -V_GAP);
  return Math.max(NODE_H, childrenH);
}

interface Positioned {
  node: InvocationNode;
  x: number;
  y: number;
  children: Positioned[];
}

function layout(node: InvocationNode, x: number, y: number): Positioned {
  const kids = node.children ?? [];
  if (!kids.length) return { node, x, y, children: [] };

  const childX = x + NODE_W + H_GAP;
  let cursor = y;
  const children: Positioned[] = kids.map((child) => {
    const h = treeHeight(child);
    const childY = cursor + (h - NODE_H) / 2;
    cursor += h + V_GAP;
    return layout(child, childX, childY);
  });

  // Centre parent vertically over its children
  const firstY = children[0].y;
  const lastY = children[children.length - 1].y;
  const centredY = (firstY + lastY) / 2;

  return { node, x, y: centredY, children };
}

function collectEdges(p: Positioned): { x1: number; y1: number; x2: number; y2: number }[] {
  const edges: { x1: number; y1: number; x2: number; y2: number }[] = [];
  for (const child of p.children) {
    edges.push({
      x1: p.x + NODE_W,
      y1: p.y + NODE_H / 2,
      x2: child.x,
      y2: child.y + NODE_H / 2,
    });
    edges.push(...collectEdges(child));
  }
  return edges;
}

function collectNodes(p: Positioned): Positioned[] {
  return [p, ...p.children.flatMap(collectNodes)];
}

function NodeBox({ p }: { p: Positioned }) {
  return (
    <g>
      <rect
        x={p.x}
        y={p.y}
        width={NODE_W}
        height={NODE_H}
        rx={6}
        fill="var(--surface)"
        stroke="var(--accent)"
        strokeWidth={1.5}
      />
      <text
        x={p.x + NODE_W / 2}
        y={p.y + 18}
        textAnchor="middle"
        fill="var(--accent)"
        fontSize={11}
        fontFamily="monospace"
      >
        {short(p.node.contract)}
      </text>
      <text
        x={p.x + NODE_W / 2}
        y={p.y + 36}
        textAnchor="middle"
        fill="var(--text)"
        fontSize={12}
        fontWeight={600}
        fontFamily="monospace"
      >
        {p.node.fn}
      </text>
    </g>
  );
}

export default function InvocationFlowChart({ root }: Props) {
  const tree = layout(root, 0, 0);
  const nodes = collectNodes(tree);
  const edges = collectEdges(tree);

  // Compute bounding box
  const maxX = Math.max(...nodes.map((n) => n.x + NODE_W));
  const minY = Math.min(...nodes.map((n) => n.y));
  const maxY = Math.max(...nodes.map((n) => n.y + NODE_H));
  const pad = 16;
  const width = maxX + pad;
  const height = maxY - minY + pad * 2;
  const offsetY = -minY + pad;

  return (
    <div className="card" style={{ overflowX: "auto", padding: 0 }}>
      <div
        style={{
          padding: "10px 16px",
          borderBottom: "1px solid var(--border)",
          fontSize: 13,
          color: "var(--muted)",
        }}
      >
        Cross-Contract Invocation Flow
      </div>
      <svg
        width={width}
        height={height}
        style={{ display: "block", minWidth: width }}
        aria-label="Cross-contract invocation flow chart"
      >
        <g transform={`translate(${pad / 2}, ${offsetY})`}>
          {/* Edges first so nodes render on top */}
          {edges.map((e, i) => {
            const mx = (e.x1 + e.x2) / 2;
            return (
              <path
                key={i}
                d={`M${e.x1},${e.y1} C${mx},${e.y1} ${mx},${e.y2} ${e.x2},${e.y2}`}
                fill="none"
                stroke="var(--border)"
                strokeWidth={1.5}
                markerEnd="url(#arrow)"
              />
            );
          })}
          <defs>
            <marker id="arrow" markerWidth={8} markerHeight={8} refX={8} refY={3} orient="auto">
              <path d="M0,0 L0,6 L8,3 z" fill="var(--muted)" />
            </marker>
          </defs>
          {nodes.map((p, i) => (
            <NodeBox key={i} p={p} />
          ))}
        </g>
      </svg>
    </div>
  );
}
