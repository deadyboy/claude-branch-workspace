// Frontend mirror of the control-plane / domain shapes (the SPA is a thin
// client; it reads these exact JSON bodies from the REST routes and WS frames).

export type WorkspaceMode = "shared" | "worktree";
export type OriginStrategy =
  | "root"
  | "fork_head"
  | "fork_node"
  | "reconstruct";

export interface Branch {
  id: string;
  projectId: string;
  parentBranchId: string | null;
  forkFromNodeId: string | null;
  displayName: string | null;
  originStrategy: OriginStrategy;
  workspaceMode: WorkspaceMode;
  runtimeAdapter: string;
  runtimeSessionId: string | null;
  runtimeProfileId: string | null;
  workspacePath: string | null;
  status: "active" | "archived";
  createdAt: string;
  archivedAt: string | null;
}

export interface Project {
  id: string;
  name: string;
  createdAt: string;
}

export type ConversationNodeStatus = "pending" | "completed" | "failed" | "cancelled";
export type TurnStatus = "completed" | "failed" | "cancelled";

export interface ConversationNode {
  id: string;
  projectId: string;
  branchId: string;
  parentNodeId: string | null;
  localTurnIndex: number;
  userMessageRef: string;
  assistantMessageRef: string | null;
  runtimeUserMessageId: string | null;
  runtimeAssistantMessageId: string | null;
  status: ConversationNodeStatus;
  createdAt: string;
  completedAt: string | null;
}

export type AgentRunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "needs_attention"
  | "completed"
  | "failed"
  | "cancelled";

export interface AgentRun {
  id: string;
  ownerBranchId: string;
  ownerNodeId: string | null;
  parentAgentRunId: string | null;
  runtimeAgentId: string | null;
  type: string;
  displayLabel: string | null;
  name: string | null;
  taskSummary: string | null;
  status: AgentRunStatus;
  startedAt: string;
  endedAt: string | null;
}

// Effective-conversation read model (gate 3): each item carries origin so the
// UI can render the [inherited]/[local] badge on forked branches.
export interface EffectiveConversationItem {
  role: "user" | "assistant";
  content: string;
  nodeId: string;
  origin: "inherited" | "local";
  seq: number;
}

// A WS frame (gate 8). seqRel is the project monotonic cursor; live + gap-fill
// frames both carry it, plus projectId so a shared socket can attribute.
export interface EventFrame {
  eventId: string;
  seqRel: number;
  type: string;
  status: string | null;
  projectId: string;
  branchId: string | null;
  nodeId: string | null;
  agentRunId: string | null;
  runtimeSessionId: string | null;
  occurredAt: string;
  payload: unknown;
}

// The server returns attention cards in this wire shape (GET /api/attention).
export interface AttentionCardWire {
  attentionId: string;
  branchId: string | null;
  projectId: string | null;
  type: "permission" | "question" | "task";
  requestText: string;
  status: "pending" | "answered";
  answer: "allow" | "deny" | null;
  createdAt: string;
  answeredAt: string | null;
}

// The normalized shape the UI renders.
export interface AttentionCard {
  id: string;
  branchId: string | null;
  kind: "permission" | "attention";
  title: string;
  detail?: string | null;
  status: "pending" | "answered";
  answer?: "allow" | "deny" | null;
  createdAt: string;
}
