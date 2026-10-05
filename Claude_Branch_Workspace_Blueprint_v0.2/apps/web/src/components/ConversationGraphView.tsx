// S2 / E2 + E7: a real conversation GRAPH, not a flat branch list.
//
// Deliberately dependency-free SVG layering on top of the pure projection in
// lib/conversationGraph.ts. The experiment plan requires measuring real D2 (100
// turns) and D3 (1000 turns) layouts BEFORE locking in a rendering library, so
// this proves the data projection and gives the measurement a baseline without
// committing the project to a new dependency (and its React-18/lockfile risk).
//
// Layout is computed from genealogy, never from user intent: dragging a node
// rearranges only `positions` and can never mutate ancestry (S0 §2.3.2).

import { useMemo, useState } from "react";
import { buildConversationGraph } from "../lib/conversationGraph";
import type { ConversationGraph, GraphNode } from "../lib/conversationGraph";
import { useStore } from "../store/useStore";
import type { Branch } from "../types";

const COL_W = 168;
const ROW_H = 40;
const NODE_W = 132;
const NODE_H = 24;

interface Positioned {
  node: GraphNode;
  x: number;
  y: number;
}

/**
 * Depth-first layout that groups a branch with its own turns in a column and
 * places forks to the right of the turn they came from. Deterministic for a
 * given graph, which keeps the 5-run performance measurement comparable.
 */
function layout(graph: ConversationGraph): Map<string, Positioned> {
  const placed = new Map<string, Positioned>();
  const childrenOf = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.kind !== "fork") continue;
    const list = childrenOf.get(edge.source) ?? [];
    list.push(edge.target);
    childrenOf.set(edge.source, list);
  }
  // Sort fork children by id so two runs lay out identically.
  for (const list of childrenOf.values()) list.sort();

  const turnChildren = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.kind !== "turnSeq") continue;
    const list = turnChildren.get(edge.source) ?? [];
    list.push(edge.target);
    turnChildren.set(edge.source, list);
  }

  const branchNodes = graph.nodes.filter((n) => n.kind === "branch");
  const roots = branchNodes.filter((b) => !graph.edges.some((e) => e.kind === "parent" && e.target === b.id));
  let cursorY = 0;

  const visited = new Set<string>();
  function placeBranch(branchNodeId: string, depth: number): void {
    if (visited.has(branchNodeId)) return;
    visited.add(branchNodeId);
    const branchId = branchNodeId.slice("branch:".length);
    const node = graph.nodes.find((n) => n.id === branchNodeId);
    if (!node) return;
    placed.set(branchNodeId, { node, x: depth * COL_W, y: cursorY });
    cursorY += ROW_H;

    // The branch's own turns continue down the same column.
    const ownTurns = graph.edges
      .filter((e) => e.kind === "owns" && e.source === branchNodeId && e.target.startsWith("turn:"))
      .map((e) => graph.nodes.find((n) => n.id === e.target))
      .filter((n): n is GraphNode => Boolean(n))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
    for (const turn of ownTurns) {
      if (placed.has(turn.id)) continue;
      placed.set(turn.id, { node: turn, x: depth * COL_W, y: cursorY });
      cursorY += ROW_H;
    }

    // Forks from any of this branch's turns move one column right.
    for (const turn of ownTurns) {
      for (const childBranchNodeId of childrenOf.get(turn.id) ?? []) {
        placeBranch(childBranchNodeId, depth + 1);
      }
    }
    // A branch id that is referenced only via parent edges still needs placing.
    void branchId;
    void turnChildren;
  }

  for (const root of roots.sort((a, b) => a.id.localeCompare(b.id))) placeBranch(root.id, 0);
  // Any branch not reachable from a root (archived orphans) still renders.
  for (const b of branchNodes.sort((a, b) => a.id.localeCompare(b.id))) placeBranch(b.id, 0);

  return placed;
}

const NODE_FILL: Record<string, string> = {
  branch: "#1b202b",
  turn: "#161a22",
  agentRun: "#20161a",
};
const STATUS_STROKE: Record<string, string> = {
  completed: "#34c759",
  pending: "#4f8cff",
  failed: "#ff5252",
  cancelled: "#ff9f43",
  active: "#4f8cff",
  archived: "#8b94a3",
};

export function ConversationGraphView({ onSelectTurn }: { onSelectTurn?: (nodeId: string) => void }) {
  const st = useStore();
  const [selected, setSelected] = useState<string | null>(null);

  const graph = useMemo(
    () =>
      buildConversationGraph({
        branches: st.branches,
        nodesByBranch: st.nodesByBranch,
        agentRunsByBranch: st.agentRunsByBranch,
        includeAgentRuns: true,
      }),
    [st.branches, st.nodesByBranch, st.agentRunsByBranch]
  );

  const positions = useMemo(() => layout(graph), [graph]);

  if (graph.nodes.length === 0) {
    return <div className="empty">No branches to graph yet.</div>;
  }

  const xs = Array.from(positions.values()).map((p) => p.x);
  const ys = Array.from(positions.values()).map((p) => p.y);
  const width = Math.max(...xs, 0) + NODE_W + 24;
  const height = Math.max(...ys, 0) + NODE_H + 24;

  const selectedNode = selected ? graph.nodes.find((n) => n.id === selected) : null;

  return (
    <div className="graph-wrap">
      <div className="graph-hd">
        <span>
          Conversation Graph{" "}
          <span className="badge subtle">{graph.nodes.length} nodes</span>{" "}
          <span className="badge subtle">{graph.edges.length} edges</span>
        </span>
        <span className="graph-legend">
          <span className="lg lg-fork" /> fork
          <span className="lg lg-parent" /> parent
          <span className="lg lg-turn" /> turn
        </span>
      </div>
      <div className="graph-scroll" data-testid="graph-scroll">
        <svg
          width={width}
          height={height}
          role="img"
          aria-label="Conversation graph"
          data-testid="conversation-graph"
        >
          {/* Edges first so nodes paint above them. Kind is encoded by both
              colour and dash pattern: a fork edge must never be mistaken for a
              within-branch sequence edge (S0 §2.2). */}
          {graph.edges.map((edge) => {
            const a = positions.get(edge.source);
            const b = positions.get(edge.target);
            if (!a || !b) return null;
            const x1 = a.x + NODE_W;
            const y1 = a.y + NODE_H / 2;
            const x2 = b.x;
            const y2 = b.y + NODE_H / 2;
            return (
              <path
                key={edge.id}
                className={`edge edge-${edge.kind}`}
                d={`M ${x1} ${y1} C ${x1 + 24} ${y1}, ${x2 - 24} ${y2}, ${x2} ${y2}`}
                fill="none"
                data-edge-kind={edge.kind}
              />
            );
          })}
          {Array.from(positions.values()).map(({ node, x, y }) => {
            const isSelected = selected === node.id;
            const forkable = node.kind === "turn" && node.forkable;
            return (
              <g
                key={node.id}
                transform={`translate(${x},${y})`}
                className={`gnode gnode-${node.kind} ${isSelected ? "selected" : ""}`}
                onClick={() => {
                  setSelected(node.id);
                  if (node.kind === "turn" && node.nodeId && onSelectTurn) onSelectTurn(node.nodeId);
                }}
                data-node-id={node.id}
                data-node-kind={node.kind}
              >
                <rect
                  width={NODE_W}
                  height={NODE_H}
                  rx={5}
                  fill={NODE_FILL[node.kind] ?? "#161a22"}
                  stroke={STATUS_STROKE[node.status] ?? "#262d3a"}
                  strokeWidth={isSelected ? 2 : 1}
                />
                <text x={8} y={16} className="gnode-label">
                  {node.kind === "turn" && forkable ? "⑂ " : ""}
                  {node.label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      {selectedNode && (
        <div className="graph-inspect" data-testid="graph-inspect">
          <span className="badge subtle">{selectedNode.kind}</span>
          <strong>{selectedNode.label}</strong>
          <span className="graph-inspect-meta">
            branch {selectedNode.branchId.slice(0, 4)} · {selectedNode.status}
          </span>
          {selectedNode.kind === "turn" && (
            <span className="graph-inspect-meta">
              {selectedNode.forkable ? "completed — forkable" : "not forkable"}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** Breadcrumb for the active branch, using the projection's ancestry trail. */
export function BranchBreadcrumb({ branch }: { branch: Branch | undefined }) {
  const st = useStore();
  const trail = useMemo(() => {
    if (!branch) return [];
    const g = buildConversationGraph({ branches: st.branches, nodesByBranch: st.nodesByBranch });
    return g.breadcrumbs[branch.id] ?? [];
  }, [branch, st.branches, st.nodesByBranch]);

  if (!branch || trail.length === 0) return null;
  return (
    <div className="breadcrumb" data-testid="branch-breadcrumb">
      {trail.map((step, index) => (
        <span key={step.id} className="crumb">
          {index > 0 && <span className="crumb-sep">/</span>}
          <span className={step.id === branch.id ? "crumb-current" : ""}>
            {step.label}
            <span className="crumb-id">{step.id.slice(0, 4)}</span>
          </span>
        </span>
      ))}
    </div>
  );
}
