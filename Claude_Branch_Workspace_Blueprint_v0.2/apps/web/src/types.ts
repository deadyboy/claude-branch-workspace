// Frontend mirror of the control-plane / domain shapes (the SPA is a thin
// client; it reads these exact JSON bodies from the REST routes and WS frames).

export type WorkspaceMode = "shared" | "worktree";
export type OriginStrategy =
  | "native_head_fork"
  | "native_historical_fork"
  | "replay_reconstruction"
  | "imported"
  // Keep the older labels readable when the UI is connected to a pre-Phase6
  // control plane. They are still opaque display metadata, never identity.
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
  rootPath: string | null;
  createdAt: string;
  updatedAt?: string;
}

// Execution host (S0 freeze §3): ONE control-plane instance == ONE host, and
// project.rootPath is always a path on THAT host. The browser cannot hand a
// remote host a local directory, so the UI must always show which machine a
// project will execute on rather than implying the user's own filesystem.
export interface Host {
  hostname: string;
  platform: string;
  cwd: string;
  adapters: string[];
}

// Why a workspace mode is or is not offerable (S0 freeze §4.1). `dirty` alone
// never makes the project unusable — shared mode always works; it only gates
// worktree creation, which needs a clean source.
export interface ProjectCapabilities {
  rootPath: string | null;
  exists: boolean;
  isGit: boolean;
  dirty: boolean;
  hasCommits: boolean;
  worktreeAvailable: boolean;
  worktreeReason: string | null;
  sharedAvailable: boolean;
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

// S4 / E4b: applying a task's result to a target directory. The preview is a
// PURE READ — nothing is written until an explicit confirm with its token.
export type ApplyAction = "write" | "delete";
export type ApplyDecision = "apply" | "skip" | "conflict";

export interface ApplyFileSummary {
  path: string;
  action: ApplyAction;
  /** The source change status this op came from (a rename expands to delete+write). */
  status: ChangeStatus;
  group: "committed" | "uncommitted" | "untracked";
  decision: ApplyDecision;
  reason?: string;
}

export interface ApplyConflict {
  path: string;
  reason: string;
}

export interface ApplyPreview {
  preview: true;
  taskId: string;
  projectId: string;
  branchId: string | null;
  sourceWorkspacePath: string | null;
  sourceWorkspaceMode: WorkspaceMode;
  baseRef: string | null;
  sharedWorkspace: boolean;
  targetPath: string;
  targetExists: boolean;
  targetIsGit: boolean;
  targetDirty: boolean;
  files: ApplyFileSummary[];
  conflicts: ApplyConflict[];
  canApply: boolean;
  /** Set (with a reason) when changes could not be enumerated safely. */
  blocked: string | null;
  confirmToken: string;
}

export interface ApplyResult {
  status: "applied" | "failed" | "partial" | "replayed";
  operationId: string;
  taskId: string;
  projectId: string;
  branchId: string | null;
  targetPath: string;
  baseRef: string | null;
  applied: string[];
  pending: string[];
  targetRestored: boolean;
  backupDir: string | null;
  error: string | null;
  replayed: boolean;
}

// S4 / E5: durable units of work. A Task persists and may be attempted several
// times; a TaskAttempt is ONE try. Retries never overwrite an earlier attempt.
export type TaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface Task {
  id: string;
  projectId: string;
  branchId: string | null;
  title: string;
  instructions: string;
  role: string | null;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
}

export interface TaskAttempt {
  id: string;
  taskId: string;
  branchId: string | null;
  nodeId: string | null;
  agentRunId: string | null;
  status: TaskStatus;
  resultRef: string | null;
  error: string | null;
  startedAt: string;
  endedAt: string | null;
}

export interface TaskDetail extends Task {
  attempts: TaskAttempt[];
}

// S3 / E4a: the read-only result review for a branch's work.
export type ChangeStatus = "added" | "modified" | "deleted" | "renamed" | "untracked";

export interface ChangeEntry {
  path: string;
  status: ChangeStatus;
  oldPath?: string;
  binary: boolean;
  sizeBytes?: number;
  /** null for binary files — contents are never diffed (S0 §4.2). */
  patch?: string | null;
}

export interface BranchChanges {
  baseRef: string | null;
  workspacePath: string | null;
  workspaceMode: WorkspaceMode;
  /** Commits made during the run — separate from uncommitted on purpose. */
  committed: ChangeEntry[];
  uncommitted: ChangeEntry[];
  untracked: ChangeEntry[];
  truncated: boolean;
}

// Use the frozen domain graph contract so the UI renders the exact node and
// relationship semantics returned by GET /api/projects/:id/graph.
export type { ProjectGraph, ProjectGraphNode, ProjectGraphEdge } from "../../../packages/domain/src/types";

export interface FileContentResult {
  path: string;
  exists: boolean;
  binary: boolean;
  sizeBytes: number;
  content: string | null;
  truncated: boolean;
}

export interface WorkspaceStatus {
  mode: WorkspaceMode;
  path: string | null;
  isGit: boolean;
  dirty: boolean;
  conflicts: string[];
  sharedWith: string[];
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
