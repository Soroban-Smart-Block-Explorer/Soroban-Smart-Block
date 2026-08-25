/**
 * Batch Call Flow Chart Editor
 * Visual flow-chart editor with drag-and-drop call nodes
 */

import React, { useState, useCallback } from "react";
import ReactFlow, {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  MiniMap,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  Connection,
  Edge,
  Node,
  EdgeChange,
  NodeChange,
} from "react-flow-renderer";
import { BatchCall, ExecutionMode } from "../types/batch";
import { BATCH_TEMPLATES, fillTemplateParameters } from "../services/batchTemplates";

interface BatchFlowChartProps {
  initialCalls?: BatchCall[];
  onCallsChange?: (calls: BatchCall[]) => void;
  onSimulate?: (mode: ExecutionMode, calls: BatchCall[]) => Promise<void> | void;
}

function toBatchCall(node: Node): BatchCall {
  const label = String(node.data.label ?? "");
  const [functionName, contractId] = label.split("@").map((part) => part.trim());

  return {
    id: node.id,
    contractId: contractId || "",
    functionName: functionName.replace(/^Call\s*/, "") || "call",
    args: [],
    type: "call",
  };
}

function toSequentialEdges(nodes: Node[]): Edge[] {
  return nodes.slice(1).map((node, index) => ({
    id: `${nodes[index].id}-${node.id}`,
    source: nodes[index].id,
    target: node.id,
  }));
}

const nodeStyles = {
  call: {
    background: "var(--surface)",
    border: "2px solid var(--accent)",
    borderRadius: 8,
    padding: "8px 12px",
    minWidth: 160,
  },
  condition: {
    background: "var(--yellow)",
    border: "2px solid var(--yellow)",
    borderRadius: 8,
    padding: "8px 12px",
    minWidth: 120,
  },
  merge: {
    background: "var(--green)",
    border: "2px solid var(--green)",
    borderRadius: 8,
    padding: "8px 12px",
    minWidth: 120,
  },
};

export default function BatchFlowChart({
  initialCalls = [],
  onCallsChange,
  onSimulate,
}: BatchFlowChartProps) {
  const [nodes, setNodes] = useNodesState([]);
  const [edges, setEdges] = useEdgesState([]);
  const [selectedTemplate, setSelectedTemplate] = useState<string>("");
  const [templateValues, setTemplateValues] = useState<Record<string, string>>({});
  const [executionMode, setExecutionMode] = useState<ExecutionMode>("sequential");
  const [showTemplateSelector, setShowTemplateSelector] = useState(true);

  // Convert calls to nodes
  const initializeNodes = useCallback(
    (calls: BatchCall[]) => {
      const newNodes: Node[] = calls.map((call, index) => ({
        id: call.id,
        type: "default",
        position: { x: 100, y: index * 150 + 50 },
        data: {
          label: `${call.functionName || "Call"} @ ${call.contractId?.slice(0, 8) || "---"}…`,
        },
        style: nodeStyles.call,
      }));
      setNodes(newNodes);
      setEdges(toSequentialEdges(newNodes));
    },
    [setEdges, setNodes],
  );

  // Initialize on mount
  React.useEffect(() => {
    if (initialCalls.length > 0 && nodes.length === 0) {
      initializeNodes(initialCalls);
    }
  }, [initialCalls, initializeNodes, nodes.length]);

  React.useEffect(() => {
    onCallsChange?.(nodes.map(toBatchCall));
  }, [nodes, onCallsChange]);

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((eds) => addEdge({ ...connection, animated: true }, eds));
    },
    [setEdges],
  );

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setNodes((nds) => applyNodeChanges(changes, nds));
    },
    [setNodes],
  );

  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      setEdges((eds) => applyEdgeChanges(changes, eds));
    },
    [setEdges],
  );

  const handleApplyTemplate = () => {
    const template = BATCH_TEMPLATES[selectedTemplate];
    if (!template) return;
    
    const filledCalls = fillTemplateParameters(template, templateValues);
    initializeNodes(filledCalls);
    setShowTemplateSelector(false);
    onCallsChange?.(filledCalls);
  };

  const handleAddCall = () => {
    const newId = `call-${Date.now()}`;
    const newNode: Node = {
      id: newId,
      type: "default",
      position: { x: 100, y: nodes.length * 150 + 50 },
      data: { label: "Call @ ---" },
      style: nodeStyles.call,
    };
    setNodes((nds) => [...nds, newNode]);
    setEdges((eds) => {
      const previous = nodes[nodes.length - 1];
      return previous ? [...eds, { id: `${previous.id}-${newId}`, source: previous.id, target: newId }] : eds;
    });
  };

  const handleSimulate = () => {
    const calls = nodes.map(toBatchCall).filter((call) => call.contractId && call.functionName);
    if (!calls.length) return;
    onSimulate?.(executionMode, calls);
  };

  return (
    <div style={{ position: "relative", height: 500, border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={onConnect}
        fitView
      >
        <MiniMap nodeColor={() => "var(--accent)"} />
        <Controls />
        <Background />
      </ReactFlow>

      <div
        style={{
          position: "absolute",
          top: 8,
          right: 8,
          zIndex: 5,
          display: "flex",
          gap: 8,
          alignItems: "center",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: 8,
        }}
      >
        <select
          value={executionMode}
          onChange={(e) => setExecutionMode(e.target.value as ExecutionMode)}
          style={{
            padding: "6px 10px",
            fontSize: 13,
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 4,
          }}
        >
          <option value="sequential">Sequential</option>
          <option value="parallel">Parallel</option>
          <option value="hybrid">Hybrid (DAG)</option>
          <option value="batch">Batch</option>
        </select>

        <button
          onClick={handleAddCall}
          style={{
            padding: "6px 10px",
            fontSize: 13,
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 4,
          }}
        >
          Add Call
        </button>

        <button
          onClick={() => setShowTemplateSelector(!showTemplateSelector)}
          style={{
            padding: "6px 10px",
            fontSize: 13,
            background: "var(--accent)",
            border: "none",
            borderRadius: 4,
          }}
        >
          {showTemplateSelector ? "Hide Templates" : "Templates"}
        </button>

        <button
          onClick={handleSimulate}
          style={{
            padding: "6px 10px",
            fontSize: 13,
            background: "var(--green)",
            border: "none",
            borderRadius: 4,
          }}
        >
          Simulate
        </button>
      </div>

      {showTemplateSelector && (
        <div
          style={{
            position: "absolute",
            top: 8,
            left: 8,
            zIndex: 5,
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: 12,
            minWidth: 280,
            maxWidth: 360,
            maxHeight: 400,
            overflow: "auto",
          }}
        >
          <h4 style={{ fontSize: 14, marginBottom: 8 }}>Batch Templates</h4>

          <select
            value={selectedTemplate}
            onChange={(e) => setSelectedTemplate(e.target.value)}
            style={{
              width: "100%",
              padding: "6px 10px",
              marginBottom: 8,
              fontSize: 13,
            }}
          >
            <option value="">Select template...</option>
            {Object.entries(BATCH_TEMPLATES).map(([id, tmpl]) => (
              <option key={id} value={id}>
                {tmpl.icon} {tmpl.name}
              </option>
            ))}
          </select>

          {selectedTemplate && (
            <div style={{ marginBottom: 8 }}>
              {BATCH_TEMPLATES[selectedTemplate].parameters.map((param) => (
                <div key={param.name} style={{ marginBottom: 6 }}>
                  <label style={{ fontSize: 12, color: "var(--muted)" }}>
                    {param.name} ({param.type})
                  </label>
                  <input
                    type="text"
                    value={templateValues[param.name] || ""}
                    onChange={(e) =>
                      setTemplateValues((v) => ({
                        ...v,
                        [param.name]: e.target.value,
                      }))
                    }
                    placeholder={param.placeholder}
                    style={{
                      width: "100%",
                      padding: "4px 8px",
                      fontSize: 12,
                      marginTop: 2,
                    }}
                  />
                </div>
              ))}
              <button
                onClick={handleApplyTemplate}
                style={{
                  width: "100%",
                  padding: "6px 10px",
                  fontSize: 13,
                  background: "var(--yellow)",
                  border: "none",
                  borderRadius: 4,
                  marginTop: 8,
                }}
              >
                Apply Template
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}