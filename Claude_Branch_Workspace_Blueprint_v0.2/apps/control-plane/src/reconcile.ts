// Reconcile (hard gate 15, incl. reviewer B3): on control-plane boot, sweep
// whatever a crash left in a mid-flight state so the UI can never show a
// permanently-busy card:
//   1. nodes left `pending` → cancelled (never failed), their live main/subagent
//      agent runs closed `cancelled`;
//   2. orphaned `running`/`starting` runtime_sessions → `interrupted`;
//   3. (B3) ANY agent_runs still `running`/`queued`/`needs_attention`/`waiting`
//      with no live session → cancelled by owner_node_id, regardless of node
//      status — Agent Monitor therefore never renders a busy card for a
//      ghost run.

import type { DomainService } from "@cbw/domain";

export interface ReconcileReport {
  cancelledNodes: number;
  interruptedSessions: number;
  cancelledOrphanRuns: number;
}

export async function reconcileOnBoot(svc: DomainService): Promise<ReconcileReport> {
  const { cancelledNodes, interruptedSessions } = svc.reconcileTurnRuns();

  // B3: sweep ANY agent_runs still live with no owning live session. The
  // reconciliation above only closes runs under a pending node; a subagent run
  // whose node is already terminal (or whose session died in between) would
  // otherwise stick in running/queued/needs_attention forever.
  let cancelledOrphanRuns = 0;
  const liveStatuses = ["running", "queued", "needs_attention", "waiting"] as const;
  const orphanRuns = svc.listAgentRunsByStatus([...liveStatuses]);
  for (const run of orphanRuns) {
    // A run whose node is pending is handled by cancelTurn above; here we only
    // close runs NOT owned by a live session (no live session binding on that
    // branch means the process is gone after a crash).
    const ownedByPending = run.ownerNodeId !== null && svc.getNode(run.ownerNodeId)?.status === "pending";
    if (ownedByPending) continue; // cancelTurn() already closes it
    svc.completeAgentRun(run.id, "cancelled", new Date().toISOString());
    cancelledOrphanRuns++;
  }

  // Process ownership is gone after boot; no live attempt may outlive it.
  for (const project of svc.listProjects()) for (const task of svc.listTasksByProject(project.id)) {
    for (const attempt of svc.listTaskAttempts(task.id)) {
      if (attempt.status === "queued" || attempt.status === "running") {
        svc.completeTaskAttempt(attempt.id, { status: "cancelled", error: "control plane restarted during execution" });
      }
    }
  }
  return { cancelledNodes, interruptedSessions, cancelledOrphanRuns };
}
