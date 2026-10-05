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
  // E4a baseline (docs/14 §4.2): the HEAD commit observed when this branch's
  // workspace was FIRST bound — i.e. the state BEFORE the work began. Written
  // once on first binding and never overwritten, so a restart / re-bind cannot
  // silently reset the comparison point. null when unknown (shared non-Git
  // workspace, or a branch that has never been bound).
  baseRef: string | null;
  status: "active" | "archived";
  createdAt: string;
  archivedAt: string | null;
}

// ---- S3 / E4a: read-only result review (docs/14 §4.2) ----

export type ChangeStatus = "added" | "modified" | "deleted" | "renamed" | "untracked";

export interface ChangeEntry {
  path: string;
  status: ChangeStatus;
  /** Present only for renames: the path the file had at the base. */
  oldPath?: string;
  binary: boolean;
  sizeBytes?: number;
  /** Text content diff; null for binary files (contents are never diffed). */
  patch?: string | null;
}

export interface BranchChanges {
  baseRef: string | null;
  workspacePath: string | null;
  workspaceMode: WorkspaceMode;
  /** Files changed by commits made DURING this branch's work (baseRef..HEAD). */
  committed: ChangeEntry[];
  /** Working-tree changes not yet committed. */
  uncommitted: ChangeEntry[];
  /** Files git does not track yet. */
  untracked: ChangeEntry[];
  truncated: boolean;
  // ---- S1/M1 traceability (projectId/branchId/nodeId) ----
  projectId: UUID;
  branchId: UUID;
  /** The most recent completed turn of this branch, if any. */
  latestNodeId: UUID | null;
  /** The branch this one was forked from, if any. */
  sourceBranchId: UUID | null;
  /** Attribution honesty (E4a): when true, SOME of these diffs may have been
   *  written by other branches sharing the same directory — report them as
   *  "workspace changes", never as this branch's exclusive artifact. */
  sharedWorkspace: boolean;
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

// ---- S4 tasks & artifacts (docs/14 §5, E5/E4b) ----

// Aggregate task status. `queued` exists so a task can express "waiting for the
// scheduler slot" without a scheduler being implemented here (the existing
// turn-scheduler owns concurrency; this column is the durable view).
export type TaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

// One attempt's status. Deliberately the same value set as TaskStatus; a task's
// status is the aggregate of its attempts (see DomainService.updateTaskStatus
// / completeTaskAttempt).
export type TaskAttemptStatus = TaskStatus;

export interface Task {
  id: UUID;
  projectId: UUID;
  // The durable task branch this task runs on. Nullable on purpose: a caller may
  // create a task before binding a branch (UI/MCP binds it later). The control
  // plane NEVER fabricates a branch to fill this in.
  branchId: UUID | null;
  title: string;
  instructions: string;
  // E5 "所有任务角色和名称可编辑": free-form role label (minimal §5 extension).
  role: string | null;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
}

// A single try at a task. Retries append NEW attempts and retain old ones — an
// attempt row is never mutated into another attempt (E5 "重试不丢旧记录").
export interface TaskAttempt {
  id: UUID;
  taskId: UUID;
  branchId: UUID | null;
  nodeId: UUID | null;
  agentRunId: UUID | null;
  status: TaskAttemptStatus;
  resultRef: string | null;
  error: string | null;
  startedAt: string;
  endedAt: string | null;
}

export type ArtifactKind = "file" | "report" | "changeset";

// A locatable outcome and where it came from (E4a/E8 provenance). Origin fields
// are nullable because not every artifact has every source link yet.
export interface Artifact {
  id: UUID;
  projectId: UUID;
  originBranchId: UUID | null;
  originNodeId: UUID | null;
  originTaskId: UUID | null;
  kind: ArtifactKind;
  path: string | null;
  summary: string | null;
  createdAt: string;
}

// ---- E4b: applying a branch's result back to a target directory (docs/14 §4.3) ----

// Lifecycle of one apply operation. "applied" and "failed" are terminal; a
// "failed" operation left the target restored, so it may be retried. "partial"
// is a mid-apply failure whose rollback could NOT fully restore the target —
// it must never be reported as success (E4b honesty rule).
export type ApplyOperationStatus = "applying" | "applied" | "failed" | "partial";

// Durable ledger row for one apply. Keyed by a DETERMINISTIC operationId (a hash
// of the source + target descriptor), so a repeated click with the same
// confirmToken is recognised and replayed instead of re-applying (E4b idempotency).
export interface ApplyOperation {
  id: string;
  taskId: UUID;
  projectId: UUID;
  branchId: UUID | null;
  targetPath: string;
  baseRef: string | null;
  confirmToken: string;
  status: ApplyOperationStatus;
  appliedJson: string; // JSON string[] of paths actually written/deleted
  pendingJson: string; // JSON string[] of paths NOT applied (failure reporting)
  targetRestored: boolean; // true when a failed apply rolled the target back
  backupDir: string | null; // recovery entry: where pre-apply copies live
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

// The action one target file receives.
export type ApplyAction = "write" | "delete";

// What the preview decided for one file: apply it, skip it (already in the
// wanted state), or stop because it conflicts (E4b "禁止静默覆盖").
export type ApplyDecision = "apply" | "skip" | "conflict";

export interface ApplyFileSummary {
  path: string;
  action: ApplyAction;
  /** The source change status this file op came from (rename expands to delete+write). */
  status: ChangeStatus;
  group: "committed" | "uncommitted" | "untracked";
  decision: ApplyDecision;
  /** Human-readable reason, present for skip/conflict. */
  reason?: string;
}

export interface ApplyConflict {
  path: string;
  reason: string;
}

// Preview response (docs/14 §4.3). PURE READ — never touches the target.
export interface ApplyPreview {
  preview: true;
  taskId: UUID;
  projectId: UUID;
  branchId: UUID | null;
  // ---- source (where the changes come from) ----
  sourceWorkspacePath: string | null;
  sourceWorkspaceMode: WorkspaceMode;
  baseRef: string | null;
  sharedWorkspace: boolean;
  // ---- target (where they would land) ----
  targetPath: string;
  targetExists: boolean;
  targetIsGit: boolean;
  targetDirty: boolean;
  // ---- what would happen ----
  files: ApplyFileSummary[];
  conflicts: ApplyConflict[];
  canApply: boolean;
  /** Set (with a reason) when the preview could not enumerate changes safely. */
  blocked: string | null;
  truncated: boolean;
  // ---- confirmation ----
  operationId: string;
  confirmToken: string;
}

// Apply response (docs/14 §4.3). `replayed` marks an idempotent second click.
export interface ApplyResult {
  status: "applied" | "failed" | "partial" | "replayed";
  operationId: string;
  taskId: UUID;
  projectId: UUID;
  branchId: UUID | null;
  targetPath: string;
  baseRef: string | null;
  applied: string[];
  pending: string[];
  targetRestored: boolean;
  backupDir: string | null;
  error: string | null;
  replayed: boolean;
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
