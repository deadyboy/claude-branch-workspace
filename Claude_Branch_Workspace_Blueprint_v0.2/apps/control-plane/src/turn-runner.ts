// TurnRunner: executes ONE turn over the runtime adapter and returns the
// structured TurnResult (hard gates 4, 5, 6). CanonicalEvents (via
// TurnObserver) are observability only; the TurnResult is the chat truth: the
// status decision, the stop reason, and the VERBATIM assistant text captured
// from the raw runtime stream BEFORE any scrub — that is what completeTurn
// persists into messages.visible_content.
//
// Attribution honesty (gate 9): the observer attaches agentRunId (the current
// agent at emit time) to every event, but the UI intentionally renders tools
// at branch/turn level ONLY — because runtime ownership of a tool patch is
// unreliable (dropped task_updated patches, ordering ambiguity). Nothing here
// fabricates an agent-specific claim.

import { EventBus, TurnObserver } from "@cbw/event-protocol";
import type { DomainService } from "@cbw/domain";
import type { CanonicalEvent } from "@cbw/event-protocol";
import type { RuntimeAdapter, RuntimeEvent } from "@cbw/runtime";
import type { TurnResult } from "./turn-result.js";

export interface RunTurnOnceArgs {
  svc: DomainService;
  bus: EventBus;
  adapter: RuntimeAdapter;
  sessionKey: string;
  branchId: string;
  nodeId: string;
  runtimeSessionId: string | null;
  text: string;
  onMainRun?: (runId: string) => void;
}

export interface RunTurnOutcome {
  result: TurnResult;
  events: CanonicalEvent[];
}

export async function runTurnOnce(args: RunTurnOnceArgs): Promise<RunTurnOutcome> {
  const { svc, adapter } = args;
  const projectId = svc.getBranch(args.branchId)?.projectId ?? "";
  const materialized = new Set<string>();

  const observer = new TurnObserver({
    projectId,
    branchId: args.branchId,
    nodeId: args.nodeId,
    runtimeSessionId: args.runtimeSessionId,
    bus: args.bus,
    persist: (ev): number | void => {
      // Materialize parent runs referenced by payloads before their first
      // event, so event FKs resolve (review BLOCKER #2).
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
        args.onMainRun?.(parentId);
      }
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
        if (kind === "main") args.onMainRun?.(ev.agentRunId);
      }
      const recorded = svc.recordEvent({
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
      // Return the authoritative project cursor so the observer stamps it on
      // the published event before WS forwarding (gate 8).
      const seqRel = recorded.seqRel;
      if (ev.type === "agent.completed" || ev.type === "agent.failed") {
        if (ev.agentRunId) {
          svc.completeAgentRun(ev.agentRunId, ev.type === "agent.completed" ? "completed" : "failed", ev.occurredAt);
        }
      }
      return seqRel;
    },
  });

  const events: CanonicalEvent[] = [];
  const rawText: string[] = [];
  const assistantIndex = new Map<string, number>();
  let runtimeAssistantMessageId: string | null = null;
  let terminal: { status: "completed" | "failed"; stopReason: string | null; exitCode: number | null } | null = null;
  let cancelledByInterrupt = false;
  let errorMessage: string | null = null;

  try {
    for await (const raw of adapter.sendMessage(args.sessionKey, { text: args.text })) {
      // Tool-only assistant records still advance the transcript boundary.
      // Never substitute API messageId: it identifies a different surface.
      if (raw.kind === "assistant") runtimeAssistantMessageId = raw.transcriptUuid ?? null;
      // Verbatim chat truth capture — BEFORE any observer scrub (gate 4).
      if (isAssistantText(raw)) {
        const key = raw.messageId ? `id:${raw.messageId}` : `text:${raw.text}`;
        const prior = assistantIndex.get(key);
        if (prior === undefined) {
          assistantIndex.set(key, rawText.length);
          rawText.push(raw.text);
        } else {
          rawText[prior] = raw.text;
        }
      }
      if (raw.kind === "error") errorMessage = "runtime_error";
      if (raw.kind === "result") {
        terminal = {
          status: raw.exitCode === 0 ? "completed" : "failed",
          stopReason: raw.stopReason ?? null,
          exitCode: raw.exitCode ?? null,
        };
        continue; // Publish terminal state only after the stream ends successfully.
      }
      // A transcript anchor is not a visible chat message. Tool-only and
      // thinking-only records must not add blank Timeline completion entries.
      if (raw.kind === "assistant" && !raw.text) continue;
      const evs = observer.feed(raw);
      events.push(...evs);
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  // Interrupt (gate 6) → cancelled, never failed. Match the adapter's recorded
  // observation (wasInterrupted survives the child close).
  if (!terminal && typeof (adapter as unknown as { wasInterrupted?: (k: string) => boolean }).wasInterrupted === "function") {
    try {
      cancelledByInterrupt = (adapter as unknown as { wasInterrupted: (k: string) => boolean }).wasInterrupted(args.sessionKey);
    } catch {
      cancelledByInterrupt = false;
    }
  }

  const status: TurnResult["status"] = cancelledByInterrupt
    ? "cancelled"
    : errorMessage ? "failed" : terminal?.status ?? "failed";

  if (status === "cancelled") {
    const cancelled = observer.cancel();
    if (cancelled) events.push(cancelled);
  } else {
    events.push(...observer.feed({ kind: "result", exitCode: status === "completed" ? 0 : 1 }));
  }
  // End only this turn's runs; a missing worker completion is never invented.
  for (const run of svc.listAgentRunsByBranch(args.branchId)) {
    if (run.ownerNodeId !== args.nodeId || run.status !== "running") continue;
    svc.completeAgentRun(run.id,
      status === "cancelled" ? "cancelled" : status === "completed" && run.type === "main" ? "completed" : "failed",
      new Date().toISOString());
  }
  return {
    result: {
      status,
      stopReason: errorMessage ? "runtime_error" : terminal?.stopReason ?? (status === "failed" ? "missing_terminal_result" : null),
      assistantContent: rawText.length ? rawText.join("\n") : null,
      runtimeAssistantMessageId: status === "completed" ? runtimeAssistantMessageId : null,
      exitCode: terminal?.exitCode ?? null,
      eventCount: events.length,
    },
    events,
  };
}

function isAssistantText(raw: RuntimeEvent): raw is Extract<RuntimeEvent, { kind: "assistant" }> {
  return raw.kind === "assistant" && typeof raw.text === "string" && raw.text.length > 0;
}
