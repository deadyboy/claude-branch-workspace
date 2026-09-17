// TurnObserver: maps the runtime's raw event stream for ONE branch turn onto
// the canonical event model (docs/04 §3-§4), attributing every event to the
// owning branch, turn (node), and transient AgentRun, then publishing redacted
// CanonicalEvents to the EventBus and (optionally) the control-plane DB.
//
// Attribution sources (verified against the live stream-json surface,
// 2026-09-17, scripts/hook-shape-probe.mjs):
//   - tool_use (assistant content block)   -> tool.started
//   - tool_result (user content block)     -> tool.completed / tool.failed
//   - system:task_started                  -> open an AgentRun (subagent/task)
//   - system:task_notification(status)     -> complete / fail the AgentRun
//   - system:task_updated                  -> ignored (carries only tool patches)
//   - assistant text                       -> message.assistant
//   - result                               -> session.stopped
// thinking_tokens are excluded upstream (adapter parseEvent) — hidden
// chain-of-thought never reaches the UI (constitution §1.10, docs/04 §6).
//
// This module depends only on @cbw/event-protocol types; the runtime's
// RuntimeEvent satisfies the local RuntimeEventLike structurally (no cycle).

import { randomUUID } from "node:crypto";
import { EventBus } from "./event-bus.js";
import { buildRedactedPayload } from "./redact.js";
import type { CanonicalEvent, CanonicalType } from "./types.js";

// Structural view of the runtime's events (see packages/runtime/src/types.ts).
export type RuntimeEventLike =
  | { kind: "init"; externalSessionId: string; runtimeVersion?: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool_use"; name: string; input: unknown; id?: string }
  | { kind: "tool_result"; toolUseId?: string; isError?: boolean }
  | { kind: "subagent_start"; name?: string; id?: string }
  | { kind: "subagent_stop"; id?: string }
  | { kind: "attention"; summary?: string }
  | {
      kind: "task";
      id: string;
      type: string;
      status?: string;
      taskId?: string;
      toolUseId?: string;
      subagentType?: string;
      description?: string;
      summary?: string;
    }
  | { kind: "result"; stopReason?: string; exitCode?: number; sequence?: unknown }
  | { kind: "error"; message: string };

export interface ObservedEvent extends CanonicalEvent {}

export interface TurnObserverHooks {
  projectId: string;
  branchId: string;
  nodeId: string | null;
  runtimeSessionId: string | null;
  bus: EventBus;
  /** Persist one redacted canonical event to the control-plane store; returns
   *  the authoritative project-scoped seqRel (gate 8) so it can ride on the
   *  published event for WS live-forwarding. */
  persist?: (ev: CanonicalEvent) => number | void;
  now?: () => string;
}

export type AgentKind = "main" | "subagent" | "task";

interface OpenAgent {
  agentRunId: string;
  kind: AgentKind;
  ownerBranchId: string;
  ownerNodeId: string | null;
  taskId: string | null;
  startedAt: string;
}

export interface TurnSummary {
  startedAt: string;
  endedAt: string;
  events: number;
  agentRuns: { agentRunId: string; kind: AgentKind; status: string }[];
  agentsCompleted: number;
  agentsFailed: number;
}

export class TurnObserver {
  private hooks: TurnObserverHooks;
  private seqCounter = 0;
  private emitted = 0;
  private now: () => string;
  private runs: OpenAgent[] = [];
  private agents: { agentRunId: string; kind: AgentKind; status: string }[] = [];
  private runIdByTask = new Map<string, string>();
  private startedAt: string;
  private endedAt: string | null = null;

  constructor(hooks: TurnObserverHooks) {
    this.hooks = hooks;
    this.now = hooks.now ?? (() => new Date().toISOString());
    this.startedAt = this.now();
    // The turn itself is the anonymous "main" agent; subagents/tasks nest under
    // it (execution tree root, docs/04 §1).
    const id = randomUUID();
    this.runs.push({ agentRunId: id, kind: "main", ownerBranchId: hooks.branchId, ownerNodeId: hooks.nodeId, taskId: null, startedAt: this.startedAt });
    this.agents.push({ agentRunId: id, kind: "main", status: "running" });
  }

  /** Ingest one runtime event; returns the canonical event(s) emitted (or []). */
  feed(e: RuntimeEventLike): ObservedEvent[] {
    if (this.endedAt) return [];
    const out: ObservedEvent[] = [];
    const emit = (type: CanonicalType, extra: Partial<ObservedEvent> = {}) => {
      const ev = this.emit(type, extra);
      out.push(ev);
      return ev;
    };

    switch (e.kind) {
      case "init":
        emit("session.started");
        break;
      case "assistant":
        emit("message.assistant.completed", {
          payload: buildRedactedPayload({ eventId: "", type: "message.assistant.completed", occurredAt: "", receivedAt: "", projectId: "", branchId: "", nodeId: null, agentRunId: null, runtimeSessionId: null, sequence: null, text: e.text }),
        });
        break;
      case "tool_use":
        emit("tool.started", {
          payload: buildRedactedPayload({ eventId: "", type: "tool.started", occurredAt: "", receivedAt: "", projectId: "", branchId: "", nodeId: null, agentRunId: null, runtimeSessionId: null, sequence: null, toolName: e.name, toolInput: e.input, idRef: e.id }),
        });
        break;
      case "tool_result":
        emit(e.isError ? "tool.failed" : "tool.completed", {
          status: e.isError ? "failed" : "completed",
          payload: buildRedactedPayload({ eventId: "", type: e.isError ? "tool.failed" : "tool.completed", occurredAt: "", receivedAt: "", projectId: "", branchId: "", nodeId: null, agentRunId: null, runtimeSessionId: null, sequence: null, idRef: e.toolUseId }),
        });
        break;
      case "task":
        this.handleTask(e, emit);
        break;
      case "subagent_start":
        this.openSubagent(e, emit);
        break;
      case "subagent_stop":
        this.closeSubagent(emit);
        break;
      case "attention":
        emit("attention.required", {
          payload: buildRedactedPayload({
            eventId: "", type: "attention.required", occurredAt: "", receivedAt: "",
            projectId: "", branchId: "", nodeId: null, agentRunId: null, runtimeSessionId: null,
            sequence: null, summary: e.summary ?? null,
          }),
        });
        break;
      case "result":
        emit("session.stopped", { status: e.exitCode === 0 ? "completed" : "failed" });
        this.endedAt = this.now();
        break;
      default:
        break; // error / unknown dropped
    }
    return out;
  }

  currentAgent(): OpenAgent | null {
    return this.runs.length ? this.runs[this.runs.length - 1] : null;
  }

  /** Emit the user's own message as a canonical event (observability, gate 4). */
  userMessage(text: string): ObservedEvent | null {
    if (this.endedAt) return null;
    return this.emit("message.user", {
      payload: buildRedactedPayload({ eventId: "", type: "message.user", occurredAt: "", receivedAt: "", projectId: "", branchId: "", nodeId: null, agentRunId: null, runtimeSessionId: null, sequence: null, text }),
    });
  }

  /** Interrupt (gate 6): mark the turn cancelled on the canonical surface. */
  cancel(): ObservedEvent | null {
    if (this.endedAt) return null;
    const ev = this.emit("session.stopped", { status: "cancelled" });
    this.endedAt = this.now();
    return ev;
  }

  private emit(type: CanonicalType, extra: Partial<ObservedEvent> = {}): ObservedEvent {
    const ev: ObservedEvent = {
      eventId: randomUUID(),
      projectId: this.hooks.projectId,
      branchId: this.hooks.branchId,
      nodeId: this.hooks.nodeId,
      agentRunId: this.currentAgent()?.agentRunId ?? null,
      runtimeSessionId: this.hooks.runtimeSessionId,
      type,
      status: undefined,
      sequence: this.seqCounter++,
      occurredAt: this.now(),
      receivedAt: this.now(),
      payload: {},
      ...extra,
    };
    this.emitted++;
    // Persist FIRST (returns the project-scoped seqRel, gate 8) so the published
    // event carries the authoritative cursor for WS live-forwarding.
    const seqRel = this.hooks.persist?.(ev);
    if (typeof seqRel === "number") ev.seqRel = seqRel;
    this.hooks.bus.publish(ev);
    return ev;
  }

  agentRuns(): { agentRunId: string; kind: AgentKind; status: string }[] {
    return [...this.agents];
  }

  summary(): TurnSummary {
    const agentsCompleted = this.agents.filter((a) => a.status === "completed").length;
    const agentsFailed = this.agents.filter((a) => a.status === "failed").length;
    return {
      startedAt: this.startedAt,
      endedAt: this.endedAt ?? this.now(),
      events: this.emitted,
      agentRuns: [...this.agents],
      agentsCompleted,
      agentsFailed,
    };
  }

  private handleTask(
    e: Extract<RuntimeEventLike, { kind: "task" }>,
    emit: (type: CanonicalType, extra?: Partial<ObservedEvent>) => ObservedEvent
  ): void {
    const taskId = e.taskId ?? e.id;
    if (!taskId) return;
    if (e.type === "task_started" || e.type === "task_started_v2") {
      if (this.runIdByTask.has(taskId)) return;
      const runId = randomUUID();
      const kind: AgentKind = e.subagentType ? "subagent" : "task";
      const parent = this.currentAgent();
      this.runIdByTask.set(taskId, runId);
      this.runs.push({ agentRunId: runId, kind, ownerBranchId: this.hooks.branchId, ownerNodeId: this.hooks.nodeId, taskId, startedAt: this.now() });
      this.agents.push({ agentRunId: runId, kind, status: "running" });
      emit("agent.started", {
        agentRunId: runId,
        payload: {
          parentAgentRunId: parent?.agentRunId ?? null,
          name: e.subagentType ?? null,
          ...buildRedactedPayload({ eventId: "", type: "agent.started", occurredAt: "", receivedAt: "", projectId: "", branchId: "", nodeId: null, agentRunId: null, runtimeSessionId: null, sequence: null, summary: e.description ?? e.summary ?? null, idRef: taskId }),
        },
      });
    } else if (e.type === "task_notification" || e.type === "task_completed") {
      const runId = this.runIdByTask.get(taskId);
      if (!runId) return;
      const status: "completed" | "failed" = e.status === "failed" ? "failed" : "completed";
      this.updateAgentRun(runId, taskId, status, emit, e);
    }
    // task_updated / task_error carry tool patches, not agent lifecycle: ignored
  }

  private openSubagent(
    e: Extract<RuntimeEventLike, { kind: "subagent_start" }>,
    emit: (type: CanonicalType, extra?: Partial<ObservedEvent>) => ObservedEvent
  ): void {
    const parent = this.currentAgent();
    const runId = randomUUID();
    this.runs.push({ agentRunId: runId, kind: "subagent", ownerBranchId: this.hooks.branchId, ownerNodeId: this.hooks.nodeId, taskId: null, startedAt: this.now() });
    this.agents.push({ agentRunId: runId, kind: "subagent", status: "running" });
    emit("agent.started", {
      agentRunId: runId,
      payload: {
        parentAgentRunId: parent?.agentRunId ?? null,
        ...buildRedactedPayload({ eventId: "", type: "agent.started", occurredAt: "", receivedAt: "", projectId: "", branchId: "", nodeId: null, agentRunId: null, runtimeSessionId: null, sequence: null, summary: e.name ?? null, idRef: null }),
      },
    });
  }

  private closeSubagent(emit: (type: CanonicalType, extra?: Partial<ObservedEvent>) => ObservedEvent): void {
    for (let i = this.runs.length - 1; i >= 0; i--) {
      if (this.runs[i].kind === "subagent" || this.runs[i].kind === "task") {
        const r = this.runs.splice(i, 1)[0];
        this.updateAgentRun(r.agentRunId, r.taskId ?? null, "completed", emit, undefined);
        return;
      }
    }
  }

  private updateAgentRun(
    runId: string,
    taskId: string | null,
    status: "completed" | "failed",
    emit: (type: CanonicalType, extra?: Partial<ObservedEvent>) => ObservedEvent,
    task?: Extract<RuntimeEventLike, { kind: "task" }>
  ): void {
    const idx = this.runs.findIndex((r) => r.agentRunId === runId);
    if (idx >= 0) this.runs.splice(idx, 1);
    const agent = this.agents.find((a) => a.agentRunId === runId);
    if (agent) agent.status = status;
    if (taskId) this.runIdByTask.delete(taskId);
    const payload = buildRedactedPayload({
      eventId: "", type: status === "failed" ? "agent.failed" : "agent.completed",
      occurredAt: "", receivedAt: "", projectId: "", branchId: "", nodeId: null, agentRunId: null,
      runtimeSessionId: null, sequence: null, summary: task?.summary ?? task?.description ?? null, idRef: taskId ?? null,
    });
    emit(status === "failed" ? "agent.failed" : "agent.completed", { agentRunId: runId, status, payload });
  }
}
