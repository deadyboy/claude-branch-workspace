import type { AppContext } from "./context.js";
import { runTurnOnce } from "./turn-runner.js";
import { QueueCancelled } from "./turn-scheduler.js";

// Shared by ordinary messages and tasks: one scheduler and runtime lifecycle.
export function turnExecution(ctx: AppContext) {
  const { svc, sessionManager, bus, adapter, workspaceManager, scheduler } = ctx;
  function finishAttempt(attemptId: string | undefined, nodeId: string, status: "completed" | "failed" | "cancelled", error?: string) {
    if (!attemptId) return;
    const a = svc.getTaskAttempt(attemptId);
    if (!a || a.endedAt) return;
    let resultRef: string | null = nodeId;
    if (status === "completed") {
      const task = svc.getTask(a.taskId)!;
      const artifact = svc.createArtifact({ projectId: task.projectId, originTaskId: task.id,
        originBranchId: a.branchId, originNodeId: nodeId, kind: "report",
        summary: `Execution result: ${task.title}` });
      resultRef = artifact.id;
    }
    svc.completeTaskAttempt(attemptId, { status, resultRef, error: error ?? null });
  }
  async function submitTurn(branchId: string, nodeId: string, text: string, requestedCwd?: string, attemptId?: string): Promise<void> {
    try {
      const branch = svc.getBranch(branchId);
      if (!branch) throw new Error(`branch ${branchId} not found`);
      const initialCwd = requestedCwd ?? branch.workspacePath ?? svc.getProject(branch.projectId)?.rootPath ?? ".";
      // Admit synchronously before any workspace I/O so shutdown/cancellation
      // owns preparation too, rather than leaving untracked work before submit.
      const run = async () => {
        if (attemptId) svc.startTaskAttempt(attemptId);
        const cwd = workspaceManager ? await workspaceManager.bind(branch, requestedCwd ?? null) : initialCwd;
        await runTurnAsync(branchId, nodeId, text, cwd, attemptId);
      };
      if (scheduler) {
        // Include the branch identity in the key. Shared workspaces remain
        // visible to the UI, while one branch cannot deadlock another branch
        // by waiting on a nested MCP/file operation in the same directory.
        await scheduler.submit({
          branchId,
          projectId: branch.projectId,
          workspace: `${initialCwd}#${branchId}`,
          run,
        });
      } else {
        await run();
      }
    } catch (err) {
      if (err instanceof QueueCancelled) {
        try { svc.cancelTurn(nodeId); } catch { /* node already terminal */ }
        finishAttempt(attemptId, nodeId, "cancelled");
        sessionManager.release(branchId);
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      const cancelled = sessionManager.isCancellationRequested(branchId);
      try {
        if (cancelled) {
          const key = sessionManager.getState(branchId)?.sessionKey ?? null;
          svc.cancelTurn(nodeId, { runtimeSessionId: key });
        } else {
          svc.completeTurn(nodeId, { assistantContent: null, status: "failed" });
        }
      } catch { /* node already terminal */ }
      finishAttempt(attemptId, nodeId, cancelled ? "cancelled" : "failed", msg);
      sessionManager.release(branchId);
      // eslint-disable-next-line no-console
      console.error(`[turn ${branchId}/${nodeId}] ${msg}`);
    }
  }

  async function runTurnAsync(branchId: string, nodeId: string, text: string, cwd: string, attemptId?: string): Promise<void> {
    try {
      if (attemptId) svc.startTaskAttempt(attemptId);
      const st = await sessionManager.resolveSession({
        branchId,
        cwd,
      });
      // The in-flight node was claimed synchronously in the handler (gate 11)
      // and drained into st.nodeId by resolveSession; release() clears it at end.
      // A pending-start interrupt is recorded on the materialized state. Do not
      // start the user turn after cancellation; startSession may only have
      // warmed the persistent runtime handle.
      if (st.cancelRequested) {
        svc.cancelTurn(nodeId, { runtimeSessionId: st.sessionKey });
        finishAttempt(attemptId, nodeId, "cancelled");
        sessionManager.release(branchId);
        return;
      }
      const { result } = await runTurnOnce({
        svc, bus, adapter,
        sessionKey: st.sessionKey,
        branchId,
        nodeId,
        runtimeSessionId: st.sessionKey,
        text,
        onMainRun: attemptId ? (runId) => svc.attachTaskAttemptRun(attemptId, runId) : undefined,
      });
      if (result.status === "cancelled") {
        svc.cancelTurn(nodeId, { runtimeSessionId: st.sessionKey });
      } else {
        svc.completeTurn(nodeId, {
          assistantContent: result.assistantContent,
          runtimeAssistantMessageId: result.runtimeAssistantMessageId,
          status: result.status === "completed" ? "completed" : "failed",
        });
      }
      finishAttempt(attemptId, nodeId, result.status, result.status === "failed" ? result.stopReason ?? "runtime_failed" : undefined);
      sessionManager.release(branchId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const cancelled = sessionManager.isCancellationRequested(branchId);
      try {
        if (cancelled) {
          const key = sessionManager.getState(branchId)?.sessionKey ?? null;
          svc.cancelTurn(nodeId, { runtimeSessionId: key });
        } else {
          svc.completeTurn(nodeId, { assistantContent: null, status: "failed" });
        }
      } catch { /* node already terminal */ }
      finishAttempt(attemptId, nodeId, cancelled ? "cancelled" : "failed", msg);
      try { sessionManager.release(branchId); } catch { /* already cleared */ }
      // eslint-disable-next-line no-console
      console.error(`[turn ${branchId}/${nodeId}] ${msg}`);
    }
  }

  return { submitTurn };
}
