// BranchRunner: control-plane unit that owns ONE persistent branch's live
// runtime. It wires the runtime adapter to the domain persistence + realtime
// event bus, attributing every runtime event to the owning branch/turn:
//
//   adapter.sendMessage(...)  -> TurnObserver (this branch+turn) -> EventBus
//                                                            -> domain DB
//
// Persistent structure (branch/node/message) is owned by DomainService; the
// runner only records it at turn boundaries. Transient AgentRuns and canonical
// events are persisted for observability (execution tree); AgentRuns are NEVER
// promoted to branches (constitution §1).

import { randomUUID } from "node:crypto";
import type { DomainService } from "@cbw/domain";
import { EventBus, TurnObserver } from "@cbw/event-protocol";
import type { RuntimeEvent, RuntimeSession } from "@cbw/runtime";
import type { CanonicalEvent } from "@cbw/event-protocol";

export interface RunOptions {
  displayName?: string | null;
  projectInstructions?: string | null;
}

/**
 * Start a persistent branch session under an existing domain branch. Returns
 * the sessionKey to use for sendMessage.
 */
export async function startBranch(
  svc: DomainService,
  bus: EventBus,
  adapter: {
    startSession(input: { sessionId: string; cwd: string; workspaceMode: string; projectInstructions?: string | null; branchId?: string }): Promise<RuntimeSession>;
  },
  branchId: string,
  cwd: string,
  opts: RunOptions = {}
): Promise<{ sessionKey: string; session: RuntimeSession }> {
  const sessionId = randomUUID();
  const session = await adapter.startSession({
    sessionId,
    cwd,
    workspaceMode: "shared",
    projectInstructions: opts.projectInstructions ?? null,
    branchId,
  });
  // Persist the control-plane session mapping so event FKs resolve and restart
  // recovery finds the branch's external id (single fact source).
  svc.upsertRuntimeSession({
    id: sessionId,
    branchId,
    adapterType: "claude-cli",
    externalSessionId: session.externalSessionId,
    runtimeVersion: session.runtimeVersion ?? null,
    status: "running",
    lastSeenAt: new Date().toISOString(),
  });
  return { sessionKey: sessionId, session };
}

/**
 * Run one user turn on a branch; returns the turn's attributed events.
 * `runtimeSessionId` is the control-plane LOCAL session key (runtime_sessions.id)
 * so event rows satisfy the FK; the external CLI id is mapped separately in
 * runtime_sessions.
 */
export async function runTurn(
  svc: DomainService,
  bus: EventBus,
  adapter: {
    sendMessage(sessionId: string, input: { text: string }): AsyncIterable<RuntimeEvent>;
  },
  sessionKey: string,
  branchId: string,
  nodeId: string | null,
  runtimeSessionId: string | null,
  text: string
): Promise<CanonicalEvent[]> {
  const projectId = svc.getBranch(branchId)?.projectId ?? "";
  // Track which agent runs are already materialized so event FKs resolve.
  const materialized = new Set<string>();
  const observer = new TurnObserver({
    projectId,
    branchId,
    nodeId,
    runtimeSessionId,
    bus,
    persist: (ev) => {
      // An event's payload may name a parent run (parentAgentRunId). If the
      // parent is a main run the runtime never emitted as a standalone event,
      // materialize it on demand so the FK resolves (review BLOCKER #2).
      const parentId =
        typeof ev.payload?.parentAgentRunId === "string" &&
        ev.payload.parentAgentRunId !== ev.agentRunId
          ? ev.payload.parentAgentRunId
          : null;
      if (parentId && !materialized.has(parentId)) {
        svc.openAgentRun({
          id: parentId,
          ownerBranchId: ev.branchId,
          ownerNodeId: ev.nodeId,
          parentAgentRunId: null,
          type: "main",
          name: "Main",
          taskSummary: null,
          startedAt: ev.occurredAt,
        });
        materialized.add(parentId);
      }
      // materialize the owning agent run when its first event arrives
      if (ev.agentRunId && !materialized.has(ev.agentRunId)) {
        const kind =
          ev.type === "agent.started" || ev.type === "agent.failed" || ev.type === "agent.completed"
            ? "subagent"
            : "main";
        const name =
          kind === "subagent"
            ? typeof ev.payload?.name === "string"
              ? ev.payload.name
              : typeof ev.payload?.runtimeAgentId === "string"
                ? ev.payload.runtimeAgentId
                : "subagent"
            : "Main";
        const summary =
          typeof ev.payload?.task === "string"
            ? ev.payload.task
            : typeof ev.payload?.summary === "string"
              ? ev.payload.summary
              : null;
        svc.openAgentRun({
          id: ev.agentRunId,
          ownerBranchId: ev.branchId,
          ownerNodeId: ev.nodeId,
          parentAgentRunId: parentId,
          type: kind,
          name,
          taskSummary: summary,
          startedAt: ev.occurredAt,
        });
        materialized.add(ev.agentRunId);
      }
      svc.recordEvent({
        projectId: ev.projectId,
        branchId: ev.branchId,
        nodeId: ev.nodeId,
        agentRunId: ev.agentRunId,
        runtimeSessionId: ev.runtimeSessionId,
        type: ev.type,
        status: ev.status ?? null,
        occurredAt: ev.occurredAt,
        receivedAt: ev.receivedAt,
        payloadJsonRedacted: JSON.stringify(ev.payload),
      });
      // terminal agent events close the run
      if (ev.type === "agent.completed" || ev.type === "agent.failed") {
        if (ev.agentRunId) {
          svc.completeAgentRun(ev.agentRunId, ev.type === "agent.completed" ? "completed" : "failed", ev.occurredAt);
        }
      }
      // the anonymous main run closes when the turn itself stops (review MAJOR #3)
      if (ev.type === "session.stopped") {
        const main = svc.listAgentRunsByBranch(branchId).find((r) => r.type === "main" && r.status === "running");
        if (main) {
          svc.completeAgentRun(main.id, ev.status === "completed" ? "completed" : "failed", ev.occurredAt);
        }
      }
    },
  });

  const events: CanonicalEvent[] = [];
  for await (const raw of adapter.sendMessage(sessionKey, { text })) {
    events.push(...observer.feed(raw));
  }
  return events;
}
