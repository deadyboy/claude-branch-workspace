// Right pane: Agent/Execution Monitor (constitution two-tree separation —
// transient AgentRuns are NEVER promoted to branches). Attribution-honest
// (gate 9): each AgentRun is owned by a branch+node and renders under that
// node's turn; tool events display at branch/turn level only. agent.message is
// shown only with explicit sender/receiver runtime ids, never fabricated prose.

import { useStore } from "../store/useStore";
import type { AgentRun, Branch } from "../types";

export function AgentMonitor() {
  const st = useStore();
  const branchId = st.activeBranchId;
  const branch = st.branches.find((b) => b.id === branchId);
  const runs = branchId ? (st.agentRunsByBranch[branchId] ?? []) : [];
  const timeline = st.timeline;
  const activeBranchTimeline = branchId ? timeline.filter((t) => t.branchId === branchId) : [];

  if (!branchId || !branch) {
    return (
      <aside className="pane monitor">
        <div className="pane-hd"><span>Agent Monitor</span></div>
        <div className="empty">Select a branch.</div>
      </aside>
    );
  }

  // Group runs by owning node; an unattached run (ownerNodeId null) shows under
  // "turn / top".
  const groups = new Map<string | null, AgentRun[]>();
  for (const r of runs) {
    const key = r.ownerNodeId;
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }

  return (
    <aside className="pane monitor">
      <div className="pane-hd"><span>Agent Monitor</span></div>
      <div className="monitor-body">
        {runs.length === 0 && activeBranchTimeline.length === 0 && (
          <div className="empty">No agent runs for this branch yet.</div>
        )}
        {Array.from(groups.entries()).map(([nodeId, arr]) => {
          const node = (st.nodesByBranch[branchId] ?? []).find((n) => n.id === nodeId);
          return (
            <div className="monitor-group" key={nodeId ?? "top"}>
              <div className="monitor-group-hd">
                {node ? `Turn ${node.localTurnIndex + 1}` : "Top-level / unattached"}
              </div>
              {arr.map((r) => (
                <RunCard key={r.id} run={r} branch={branch} />
              ))}
            </div>
          );
        })}
        {/* Tool events at branch/turn level only (gate 9). */}
        <div className="monitor-group">
          <div className="monitor-group-hd">Tool activity (this branch)</div>
          {activeBranchTimeline.filter((t) => t.type.startsWith("tool.")).length === 0 && (
            <div className="empty small">No tool events.</div>
          )}
          {activeBranchTimeline
            .filter((t) => t.type.startsWith("tool."))
            .slice(-8)
            .map((t) => (
              <div className="tool-row" key={t.eventId} title={JSON.stringify(t.payload ?? {})}>
                <span className={`dot dot-${t.type === "tool.error" ? "error" : t.status === "running" || t.status === "started" ? "running" : "ok"}`} />
                <span>{t.type}</span>
                <span className="tool-meta">{t.nodeId ? `node ${t.nodeId.slice(0, 4)}` : ""}</span>
              </div>
            ))}
        </div>
      </div>
    </aside>
  );
}

function RunCard({ run, branch }: { run: AgentRun; branch: Branch }) {
  const label = run.displayLabel ?? run.name ?? `${run.type} (${run.id.slice(0, 4)})`;
  const status = run.status;
  const cls =
    status === "running"
      ? "running"
      : status === "completed"
      ? "ok"
      : status === "cancelled" || status === "failed"
      ? "error"
      : status;
  return (
    <div className={`run-card ${cls}`}>
      <div className="run-hd">
        <span className={`dot dot-${cls}`} />
        <span className="run-label">{label}</span>
        <span className="badge subtle">{status}</span>
      </div>
      {run.taskSummary && <div className="run-summary">{run.taskSummary}</div>}
      <div className="run-meta">
        {run.ownerBranchId === branch.id && `branch ${run.ownerBranchId.slice(0, 4)}`}
        {run.ownerNodeId ? ` · node ${run.ownerNodeId.slice(0, 4)}` : ` · (${branch.displayName ?? "top"})`}
      </div>
    </div>
  );
}
