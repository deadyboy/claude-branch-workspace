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

import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import {
  buildConversationGraph,
  layoutGraph,
  GRAPH_NODE_W as NODE_W,
  GRAPH_NODE_H as NODE_H,
} from "../lib/conversationGraph";
import { useStore } from "../store/useStore";
import { ForkDialog } from "./ForkDialog";
import type { Branch } from "../types";

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
  const [forkFrom, setForkFrom] = useState<{ branch: Branch; nodeId: string } | null>(null);

  // The store only loads turns for the ACTIVE branch. The graph is a
  // project-wide view, so without this it would draw branch boxes with no turns
  // — which is exactly what an E2 check caught. Fetch turns for any branch that
  // has none loaded yet, then the projection can show real history.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      for (const branch of st.branches) {
        if (cancelled) return;
        if (useStore.getState().nodesByBranch[branch.id]) continue;
        try {
          const nodes = await api.nodes(branch.id);
          if (cancelled) return;
          useStore.getState().setNodes(branch.id, nodes);
        } catch {
          // A branch whose nodes cannot be read still renders as a box; the
          // graph degrades rather than failing.
          useStore.getState().setNodes(branch.id, []);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [st.branches]);

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

  const positions = useMemo(() => layoutGraph(graph), [graph]);

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
          {/* Forking from the graph is the point of the whole view: the user
              picks a historical turn and branches the conversation there.
              Only a COMPLETED turn offers this (S0 §2.3.3), so the button is
              absent rather than disabled-with-no-explanation. */}
          {selectedNode.kind === "turn" && selectedNode.forkable && selectedNode.nodeId && (
            <button
              data-testid="graph-fork-button"
              onClick={() => {
                const owner = st.branches.find((b) => b.id === selectedNode.branchId);
                if (owner && selectedNode.nodeId) setForkFrom({ branch: owner, nodeId: selectedNode.nodeId });
              }}
            >
              Fork from here
            </button>
          )}
        </div>
      )}
      {forkFrom && (
        <ForkDialog
          branch={forkFrom.branch}
          defaultNodeId={forkFrom.nodeId}
          onClose={() => setForkFrom(null)}
        />
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
