// Canonical event types (docs/04 EVENT_AND_AGENT_MODEL.md §3-§4).
// Runtime-specific events are normalized into this shape before persistence;
// the UI consumes these, never raw runtime JSON.

export type UUID = string;

export type CanonicalType =
  | "session.started"
  | "session.resumed"
  | "session.stopped"
  | "session.failed"
  | "message.user"
  | "message.assistant.delta"
  | "message.assistant.completed"
  | "branch.created"
  | "branch.archived"
  | "agent.started"
  | "agent.completed"
  | "agent.failed"
  | "agent.message"
  | "task.created"
  | "task.completed"
  | "tool.started"
  | "tool.completed"
  | "tool.failed"
  | "permission.requested"
  | "attention.required"
  | "workspace.changed";

export type EventStatus = "started" | "completed" | "failed" | "cancelled";

/**
 * Normalized event envelope (docs/04 §3). `payload` is fully redacted before
 * persistence; only observable, non-secret fields are allowed through.
 */
export interface CanonicalEvent {
  eventId: UUID;
  projectId: UUID;
  branchId: UUID;
  nodeId: UUID | null;
  agentRunId: UUID | null;
  runtimeSessionId: string | null;
  type: CanonicalType;
  status?: EventStatus;
  sequence: number | null;
  occurredAt: string; // ISO
  receivedAt: string; // ISO
  payload: Record<string, unknown>;
}

/** Agent/worker lifecycle within one turn (execution tree, docs/04 §2). */
export interface AgentRunFrame {
  agentRunId: UUID;
  parentAgentRunId: UUID | null;
  runtimeAgentId: string | null;
  /** e.g. "subagent", "task", "main" */
  kind: string;
  name: string | null;
  taskSummary: string | null;
  status: "queued" | "running" | "waiting" | "needs_attention" | "completed" | "failed" | "cancelled";
  startedAt: string | null;
  endedAt: string | null;
}

export interface ExecutionRoot {
  sessionKey: string;
  branchId: UUID;
  nodeId: UUID | null;
  root: AgentRunFrame | null;
  childrenByRun: Map<UUID, AgentRunFrame[]>;
}
