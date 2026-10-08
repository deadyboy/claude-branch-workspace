// Conversation-graph projection (S2 / experiment E2).
//
// Pure, dependency-free projection from the persisted domain shapes to a
// renderable graph. Kept separate from any drawing library on purpose: the
// semantics below are the E2 acceptance truth (S0 freeze §2), and they must be
// verifiable without a browser or a renderer.
//
// Two rules that are easy to get wrong and are therefore encoded here:
//   1. Inherited messages do NOT duplicate topology. A forked branch's inherited
//      turns still reference the ORIGINAL nodeId; only its own turns are local.
//   2. Layout is not identity. Dragging a node must never mutate ancestry, so
//      nothing here derives parentage from positions.

import type { AgentRun, Branch, ConversationNode, EffectiveConversationItem } from "../types";

export type GraphNodeKind = "branch" | "turn" | "agentRun";

// Edge kinds are distinct on purpose (S0 §2.2): a fork edge and a parent edge
// answer different questions ("which turn spawned this" vs "which branch"), and
// conflating them makes the graph lie about genealogy.
export type GraphEdgeKind =
  | "fork" // branch -> the turn it forked from
  | "parent" // branch -> its parent branch
  | "turnSeq" // turn -> previous turn in the same branch
  | "owns" // branch -> turn it owns
  | "spawned"; // agentRun -> parent agentRun

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  /** Human label; never used as identity (constitution §2.5). */
  label: string;
  branchId: string;
  /** Present for turn nodes. */
  nodeId?: string;
  agentRunId?: string;
  /** Turn-only: whether this turn may be used as a fork source (S0 §2.3.3). */
  forkable?: boolean;
  status: string;
}

export interface GraphEdge {
  id: string;
  kind: GraphEdgeKind;
  source: string;
  target: string;
}

export interface ConversationGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Ancestry trails per branch, root-first, for breadcrumbs (docs/05). */
  breadcrumbs: Record<string, { id: string; label: string }[]>;
  /** Branch id -> the turn id it forked from, when it is a fork. */
  forkOrigins: Record<string, string>;
}

export interface GraphInput {
  branches: Branch[];
  /** Conversation nodes, keyed by owning branch. */
  nodesByBranch: Record<string, ConversationNode[]>;
  /** Agent runs, keyed by owning branch. */
  agentRunsByBranch?: Record<string, AgentRun[]>;
  includeAgentRuns?: boolean;
}

/** Only a completed turn is a legal fork source (S0 §2.3.3 / docs/02). */
export function isForkable(status: string): boolean {
  return status === "completed";
}

/**
 * Build the renderable conversation graph.
 *
 * Nodes are keyed by their immutable ids, never by display name, so duplicate
 * branch names stay distinguishable (hard requirement, constitution §2.5).
 */
export function buildConversationGraph(input: GraphInput): ConversationGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const breadcrumbs: Record<string, { id: string; label: string }[]> = {};
  const forkOrigins: Record<string, string> = {};

  const branchById = new Map(input.branches.map((b) => [b.id, b]));

  for (const branch of input.branches) {
    nodes.push({
      id: `branch:${branch.id}`,
      kind: "branch",
      label: branch.displayName ?? "(unnamed)",
      branchId: branch.id,
      status: branch.status,
    });

    // Parent edge: branch -> branch (structure), distinct from fork edge.
    if (branch.parentBranchId && branchById.has(branch.parentBranchId)) {
      edges.push({
        id: `parent:${branch.parentBranchId}->${branch.id}`,
        kind: "parent",
        source: `branch:${branch.parentBranchId}`,
        target: `branch:${branch.id}`,
      });
    }

    // Fork edge: branch -> the exact turn it forked from. This is what lets the
    // user locate the common ancestor and the fork point (E2).
    if (branch.forkFromNodeId) {
      forkOrigins[branch.id] = branch.forkFromNodeId;
      edges.push({
        id: `fork:${branch.forkFromNodeId}->${branch.id}`,
        kind: "fork",
        source: `turn:${branch.forkFromNodeId}`,
        target: `branch:${branch.id}`,
      });
    }

    // Owned turns, in stable local-turn order.
    const own = [...(input.nodesByBranch[branch.id] ?? [])].sort(
      (a, b) => a.localTurnIndex - b.localTurnIndex
    );
    let previousTurnId: string | null = null;
    for (const turn of own) {
      nodes.push({
        id: `turn:${turn.id}`,
        kind: "turn",
        label: `Turn ${turn.localTurnIndex + 1}`,
        branchId: branch.id,
        nodeId: turn.id,
        forkable: isForkable(turn.status),
        status: turn.status,
      });
      edges.push({
        id: `owns:${branch.id}->${turn.id}`,
        kind: "owns",
        source: `branch:${branch.id}`,
        target: `turn:${turn.id}`,
      });
      // Within-branch ordering uses the branch's own parentNodeId when present,
      // which stays correct if a turn is ever re-parented.
      const prev = turn.parentNodeId && own.some((n) => n.id === turn.parentNodeId)
        ? turn.parentNodeId
        : previousTurnId;
      if (prev) {
        edges.push({
          id: `turnSeq:${prev}->${turn.id}`,
          kind: "turnSeq",
          source: `turn:${prev}`,
          target: `turn:${turn.id}`,
        });
      }
      previousTurnId = turn.id;
    }

    if (input.includeAgentRuns) {
      for (const run of input.agentRunsByBranch?.[branch.id] ?? []) {
        nodes.push({
          id: `run:${run.id}`,
          kind: "agentRun",
          label: run.displayLabel ?? run.name ?? run.type,
          branchId: branch.id,
          agentRunId: run.id,
          status: run.status,
        });
        edges.push({
          id: `owns:${branch.id}->run:${run.id}`,
          kind: "owns",
          source: `branch:${branch.id}`,
          target: `run:${run.id}`,
        });
        if (run.parentAgentRunId) {
          edges.push({
            id: `spawned:${run.parentAgentRunId}->${run.id}`,
            kind: "spawned",
            source: `run:${run.parentAgentRunId}`,
            target: `run:${run.id}`,
          });
        }
      }
    }

    breadcrumbs[branch.id] = buildBreadcrumb(branch, branchById);
  }

  return { nodes, edges, breadcrumbs, forkOrigins };
}

/**
 * Root-first ancestry trail. IDs are included so a UI can always disambiguate
 * two branches that share a display name.
 */
export function buildBreadcrumb(
  branch: Branch,
  branchById: Map<string, Branch>
): { id: string; label: string }[] {
  const trail: { id: string; label: string }[] = [];
  const seen = new Set<string>();
  let cursor: Branch | undefined = branch;
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id); // defensive: a cycle must not hang the UI
    trail.unshift({ id: cursor.id, label: cursor.displayName ?? "(unnamed)" });
    cursor = cursor.parentBranchId ? branchById.get(cursor.parentBranchId) : undefined;
  }
  return trail;
}

/**
 * Partition the effective conversation into inherited vs local turns.
 *
 * This is the read-side counterpart to rule 1 above: inherited items point at
 * their ORIGINAL nodeId, so the UI can highlight the fork point without the
 * projection having copied any topology node (E2 "继承消息按原始 nodeId 引用").
 */
export function splitInherited(
  conversation: EffectiveConversationItem[]
): { inherited: EffectiveConversationItem[]; local: EffectiveConversationItem[] } {
  const inherited: EffectiveConversationItem[] = [];
  const local: EffectiveConversationItem[] = [];
  for (const item of conversation) {
    (item.origin === "inherited" ? inherited : local).push(item);
  }
  return { inherited, local };
}

/** Return the effective history through an exact persisted turn id. */
export function conversationThroughNode(
  conversation: EffectiveConversationItem[],
  nodeId: string
): EffectiveConversationItem[] | null {
  const end = conversation.map((item) => item.nodeId).lastIndexOf(nodeId);
  return end < 0 ? null : conversation.slice(0, end + 1);
}

/**
 * Which branch owns a given turn, following the fork chain when the turn is an
 * ancestor of the branch being viewed. Returns null when the turn is unrelated.
 */
export function resolveTurnOwner(
  turnNodeId: string,
  branches: Branch[],
  nodesByBranch: Record<string, ConversationNode[]>
): string | null {
  for (const branch of branches) {
    if ((nodesByBranch[branch.id] ?? []).some((n) => n.id === turnNodeId)) return branch.id;
  }
  return null;
}

// ---- layout -----------------------------------------------------------------
//
// Kept in this PURE module (not in the React component) for two reasons the
// review surfaced: it can then be unit-tested without a DOM, and the E7
// performance number can include layout rather than measuring projection only.
// Layout never mutates ancestry — it only assigns coordinates (S0 §2.3.2).

export const GRAPH_COL_W = 168;
export const GRAPH_ROW_H = 40;
export const GRAPH_NODE_W = 132;
export const GRAPH_NODE_H = 24;

export interface Positioned {
  node: GraphNode;
  x: number;
  y: number;
}

/**
 * Depth-first layout: a branch and its own turns occupy one column; forks sit
 * one column to the right of the turn they came from. Deterministic for a given
 * graph, so repeated measurement runs are comparable.
 */
export function layoutGraph(graph: ConversationGraph): Map<string, Positioned> {
  const placed = new Map<string, Positioned>();
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));

  const forkChildren = new Map<string, string[]>();
  const ownTurnsOf = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.kind === "fork") {
      const list = forkChildren.get(edge.source) ?? [];
      list.push(edge.target);
      forkChildren.set(edge.source, list);
    } else if (edge.kind === "owns" && edge.target.startsWith("turn:")) {
      const list = ownTurnsOf.get(edge.source) ?? [];
      list.push(edge.target);
      ownTurnsOf.set(edge.source, list);
    }
  }
  // Sort so two runs over the same graph lay out identically.
  for (const list of forkChildren.values()) list.sort();
  for (const list of ownTurnsOf.values()) {
    list.sort((a, b) => {
      const na = nodeById.get(a);
      const nb = nodeById.get(b);
      return (na?.label ?? "").localeCompare(nb?.label ?? "", undefined, { numeric: true });
    });
  }

  const branchNodes = graph.nodes.filter((n) => n.kind === "branch");
  const childBranchIds = new Set(
    graph.edges.filter((e) => e.kind === "parent").map((e) => e.target)
  );
  const roots = branchNodes.filter((b) => !childBranchIds.has(b.id));
  let cursorY = 0;

  const visited = new Set<string>();
  const placeBranch = (branchNodeId: string, depth: number): void => {
    if (visited.has(branchNodeId)) return; // cycle guard: never loop forever
    visited.add(branchNodeId);
    const node = nodeById.get(branchNodeId);
    if (!node) return;
    placed.set(branchNodeId, { node, x: depth * GRAPH_COL_W, y: cursorY });
    cursorY += GRAPH_ROW_H;

    const ownTurns = ownTurnsOf.get(branchNodeId) ?? [];
    for (const turnId of ownTurns) {
      if (placed.has(turnId)) continue;
      const turn = nodeById.get(turnId);
      if (!turn) continue;
      placed.set(turnId, { node: turn, x: depth * GRAPH_COL_W, y: cursorY });
      cursorY += GRAPH_ROW_H;
    }

    for (const turnId of ownTurns) {
      for (const childBranch of forkChildren.get(turnId) ?? []) {
        placeBranch(childBranch, depth + 1);
      }
    }
  };

  for (const root of [...roots].sort((a, b) => a.id.localeCompare(b.id))) placeBranch(root.id, 0);
  // A branch unreachable from any root (orphan/archived) still renders.
  for (const b of [...branchNodes].sort((a, b) => a.id.localeCompare(b.id))) placeBranch(b.id, 0);

  return placed;
}
