// Domain types (docs/09_DATA_MODEL.md). Names are labels, IDs are identity.

export type UUID = string;

export interface Project {
  id: UUID;
  name: string;
  rootPath: string | null;
  createdAt: string; // ISO
  updatedAt: string;
}

// S1 project entry capability probe (docs/14 §4.1). Reflects what the project's
// rootPath supports RIGHT NOW: whether an isolated worktree branch can be
// created, and if not, the human-readable reason. `sharedAvailable` is always
// true — shared-dir chat never needs Git.
export interface ProjectCapabilities {
  rootPath: string | null;
  exists: boolean;
  isGit: boolean;
  dirty: boolean;
  hasCommits: boolean;
  worktreeAvailable: boolean;
  worktreeReason: string | null;
  sharedAvailable: true;
}

export type OriginStrategy =
  | "native_head_fork"
  | "native_historical_fork"
  | "replay_reconstruction"
  | "imported";

export type WorkspaceMode = "shared" | "worktree";

export interface Branch {
  id: UUID;
  projectId: UUID;
  parentBranchId: UUID | null;
  forkFromNodeId: UUID | null;
  displayName: string | null;
  originStrategy: OriginStrategy;
  workspaceMode: WorkspaceMode;
  runtimeAdapter: string; // e.g. "claude-cli"
  runtimeSessionId: string | null;
  runtimeProfileId: string | null;
  workspacePath: string | null;
  status: "active" | "archived";
  createdAt: string;
  archivedAt: string | null;
}

// "cancelled" (Phase 4): a pending turn that was interrupted before completion —
// distinct from "failed" (the turn ran and errored). Interrupt = cancelled,
// never failed (hard gate 6).
export type ConversationNodeStatus = "pending" | "completed" | "failed" | "cancelled";

export type TurnStatus = "completed" | "failed" | "cancelled";

export interface ConversationNode {
  id: UUID;
  projectId: UUID;
  branchId: UUID;
  parentNodeId: UUID | null;
  localTurnIndex: number; // unique within branch
  userMessageRef: string; // reference to messages table
  assistantMessageRef: string | null;
  runtimeUserMessageId: string | null;
  runtimeAssistantMessageId: string | null;
  status: ConversationNodeStatus;
  createdAt: string;
  completedAt: string | null;
}

export interface Message {
  id: UUID;
  nodeId: UUID | null;
  branchId: UUID;
  role: "user" | "assistant" | "system";
  visibleContent: string;
  runtimeMessageId: string | null;
  // Intentionally strictly increasing per branch: creation order across turns,
  // since all rows of a turn share one createdAt timestamp.
  seq: number;
  createdAt: string;
}

export interface RuntimeSession {
  id: UUID;
  branchId: UUID;
  adapterType: string;
  externalSessionId: string | null;
  runtimeVersion: string | null;
  status: "starting" | "running" | "stopped" | "failed" | "interrupted";
  lastSeenAt: string;
  metadataJson: string;
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
  id: UUID;
  ownerBranchId: UUID;
  ownerNodeId: UUID | null;
  parentAgentRunId: UUID | null;
  runtimeAgentId: string | null;
  type: string; // e.g. "subagent" | "task" | "main"
  displayLabel: string | null;
  name: string | null;
  taskSummary: string | null;
  status: AgentRunStatus;
  startedAt: string;
  endedAt: string | null;
}

// Canonical event as persisted (docs/04 §3). payload is the REDACTED payload.
export type DomainEventStatus = "started" | "completed" | "failed" | "cancelled";

export interface DomainEvent {
  id: UUID;
  projectId: UUID;
  branchId: UUID;
  nodeId: UUID | null;
  agentRunId: UUID | null;
  runtimeSessionId: string | null;
  type: string; // canonical type, e.g. "tool.started"
  status: DomainEventStatus | null;
  sequence: number | null;
  // Project-scoped monotonic cursor (Phase 4, gate 8): monotonically
  // increasing across ALL events of the project, assigned by the single
  // writer in insert order. The durable reconnect cursor.
  seqRel: number;
  occurredAt: string;
  receivedAt: string;
  payloadJsonRedacted: string;
}

// Effective-conversation read model (Phase 4, gate 3): the chat as a branch
// actually sees it — inherited ancestor messages (up to and including the fork
// point, origin "inherited") plus the branch's own local messages (origin
// "local"). listMessagesByBranch alone cannot describe a forked branch.
export interface EffectiveConversationItem {
  role: "user" | "assistant";
  content: string;
  nodeId: UUID;
  origin: "inherited" | "local";
  seq: number;
}

// Execution tree projection: the agent runs that happened during one turn.
export interface ExecutionTree {
  sessionKey: string;
  branchId: UUID;
  nodeId: UUID | null;
  root: ExecutionNode | null;
}

export interface ExecutionNode {
  agentRun: AgentRun;
  children: ExecutionNode[];
}

// Branch context snapshot used for reconstruction fork (ADR-006 Option 3).
export interface BranchContextSnapshot {
  branchId: UUID;
  forkFromNodeId: UUID;
  ancestorNodeIds: UUID[];
  // visible conversation turns up to (and including) the fork point, oldest first
  visibleMessages: { role: "user" | "assistant"; content: string }[];
  projectInstructions: string | null;
  workspaceBinding: { mode: WorkspaceMode; path: string | null } | null;
  createdAt: string;
}
