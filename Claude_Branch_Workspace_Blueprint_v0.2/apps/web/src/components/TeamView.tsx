// Team dispatch and task history. Durable task branches remain separate from
// transient AgentRuns, and every retry creates a real runtime attempt.

import { useCallback, useEffect, useRef, useState } from "react";
import { useStore, branchBusy } from "../store/useStore";
import { api } from "../api/client";
import type { AgentRun, Task, TaskAttempt, WorkspaceMode } from "../types";
import { ApplyPanel } from "./ApplyPanel";

const RUN_META: Record<string, { dot: string; cls: string }> = {
  running: { dot: "running", cls: "running" },
  queued: { dot: "idle", cls: "queued" },
  waiting: { dot: "attention", cls: "waiting" },
  needs_attention: { dot: "attention", cls: "waiting" },
  completed: { dot: "ok", cls: "ok" },
  failed: { dot: "error", cls: "error" },
  cancelled: { dot: "error", cls: "error" },
};

export function TeamView({ onOpenBranch }: { onOpenBranch?: (branchId: string) => void }) {
  const st = useStore();
  const projectId = st.activeProjectId;
  const [tasks, setTasks] = useState<Task[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const expandedTaskRef = useRef<string | null>(null);
  const detailRequestRef = useRef(0);
  const [attempts, setAttempts] = useState<TaskAttempt[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef(new Set<string>());
  const [error, setError] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftInstructions, setDraftInstructions] = useState("");
  const [draftRole, setDraftRole] = useState("");
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("shared");
  const [showForm, setShowForm] = useState(false);
  const [applyFor, setApplyFor] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState({ title: "", instructions: "", role: "" });
  const [worktreeReason, setWorktreeReason] = useState<string | null>(null);
  const hasCompletedAnchor = Boolean(st.activeBranchId && (st.nodesByBranch[st.activeBranchId] ?? []).some((node) => node.status === "completed"));

  const reload = useCallback(async () => {
    if (!projectId) return;
    try {
      const next = await api.listTasks(projectId);
      if (useStore.getState().activeProjectId === projectId) setTasks(next);
    } catch (e) {
      if (useStore.getState().activeProjectId === projectId) setError(errorText(e));
    }
  }, [projectId]);

  useEffect(() => {
    setTasks([]);
    setExpanded(null);
    expandedTaskRef.current = null;
    detailRequestRef.current += 1;
    setAttempts([]);
    setError(null);
    if (!projectId) return;
    const cached = useStore.getState().capabilitiesByProject[projectId];
    if (cached) setWorktreeReason(cached.worktreeAvailable ? null : cached.worktreeReason ?? "Worktree is unavailable for this project.");
    let disposed = false;
    void api.capabilities(projectId).then((caps) => {
      if (disposed || useStore.getState().activeProjectId !== projectId) return;
      useStore.getState().setCapabilities(projectId, caps);
      setWorktreeReason(caps.worktreeAvailable ? null : caps.worktreeReason ?? "Worktree is unavailable for this project.");
    }).catch(() => {
      if (!disposed && useStore.getState().activeProjectId === projectId) setWorktreeReason("Worktree availability could not be checked.");
    });
    void reload();
    const timer = setInterval(() => {
      void reload();
      const taskId = expandedTaskRef.current;
      if (!taskId) return;
      const requestId = ++detailRequestRef.current;
      void api.getTask(taskId).then((detail) => {
        if (detailRequestRef.current !== requestId || expandedTaskRef.current !== taskId) return;
        if (useStore.getState().activeProjectId === projectId) setAttempts(detail.attempts ?? []);
      }).catch(() => {
        if (detailRequestRef.current === requestId && expandedTaskRef.current === taskId && useStore.getState().activeProjectId === projectId) setAttempts([]);
      });
    }, 4000);
    return () => { disposed = true; clearInterval(timer); };
  }, [projectId, reload]);

  async function openTask(task: Task): Promise<void> {
    if (expanded === task.id) {
      expandedTaskRef.current = null;
      detailRequestRef.current += 1;
      setExpanded(null);
      return;
    }
    expandedTaskRef.current = task.id;
    const requestId = ++detailRequestRef.current;
    setExpanded(task.id);
    try {
      const detail = await api.getTask(task.id);
      if (detailRequestRef.current === requestId && expandedTaskRef.current === task.id && useStore.getState().activeProjectId === projectId) setAttempts(detail.attempts ?? []);
    } catch {
      if (detailRequestRef.current === requestId && expandedTaskRef.current === task.id && useStore.getState().activeProjectId === projectId) setAttempts([]);
    }
  }

  async function interruptBranch(branchId: string): Promise<void> {
    if (busyRef.current.has(branchId)) return;
    busyRef.current.add(branchId);
    setBusy(branchId);
    setError(null);
    try {
      await api.interrupt(branchId);
      await reload();
    } catch (e) {
      if (useStore.getState().activeProjectId === projectId) setError(errorText(e));
    } finally {
      busyRef.current.delete(branchId);
      setBusy(null);
    }
  }

  async function retryTask(task: Task): Promise<void> {
    if (busyRef.current.has(task.id)) return;
    busyRef.current.add(task.id);
    setBusy(task.id);
    setError(null);
    try {
      // The run endpoint creates a new attempt and starts the branch runtime.
      // Never mark it cancelled immediately: the attempt remains live until the
      // runtime reports its real terminal state.
      await api.runTask(task.id);
      await reload();
      if (expandedTaskRef.current === task.id && useStore.getState().activeProjectId === projectId) {
        const requestId = ++detailRequestRef.current;
        const detail = await api.getTask(task.id);
        if (detailRequestRef.current === requestId && expandedTaskRef.current === task.id && useStore.getState().activeProjectId === projectId) {
          setAttempts(detail.attempts ?? []);
        }
      }
    } catch (e) {
      if (useStore.getState().activeProjectId === projectId) setError(errorText(e));
    } finally {
      busyRef.current.delete(task.id);
      setBusy(null);
    }
  }

  async function dispatch(): Promise<void> {
    const title = draftTitle.trim();
    const instructions = draftInstructions.trim();
    if (!title || !instructions || !projectId || busyRef.current.has("dispatch")) return;
    busyRef.current.add("dispatch");
    setBusy("dispatch");
    setError(null);
    try {
      let branch;
      if (workspaceMode === "shared") {
        branch = (await api.createRoot(projectId, title, "shared")).branch;
      } else {
        // The completed-anchor affordance is rendered from the local cache,
        // which can lag a just-finished turn or branch refresh. Resolve the
        // selected branch and its completed nodes from the control plane when
        // dispatching so the validation and fork use the same current data.
        const activeBranchId = useStore.getState().activeBranchId;
        const [branches, nodes] = activeBranchId
          ? await Promise.all([api.listBranches(projectId), api.nodes(activeBranchId)])
          : [[], []];
        if (useStore.getState().activeBranchId !== activeBranchId || useStore.getState().activeProjectId !== projectId) return;
        const activeBranch = branches.find((b) => b.id === activeBranchId && b.projectId === projectId);
        const anchor = activeBranch
          ? [...nodes].reverse().find((node) => node.status === "completed")
          : undefined;
        if (!activeBranch || !anchor) {
          setError("Complete a turn before dispatching an isolated task.");
          return;
        }
        useStore.getState().setBranches(branches);
        useStore.getState().setNodes(activeBranch.id, nodes);
        branch = (await api.createFork(projectId, anchor.id, title, "worktree")).branch;
      }

      const task = await api.createTask(projectId, title, instructions, branch.id, draftRole.trim() || null);
      try {
        await api.runTask(task.id);
      } catch (runError) {
        const branches = await api.listBranches(projectId).catch(() => null);
        if (branches && useStore.getState().activeProjectId === projectId) useStore.getState().setBranches(branches);
        await reload();
        throw new Error(`Task was saved but its runtime did not start: ${errorText(runError)}`);
      }
      if (useStore.getState().activeProjectId === projectId) {
        setDraftTitle("");
        setDraftInstructions("");
        setDraftRole("");
        setShowForm(false);
      }
      const [branches] = await Promise.all([api.listBranches(projectId), reload()]);
      if (useStore.getState().activeProjectId === projectId) {
        useStore.getState().setBranches(branches);
      }
    } catch (e) {
      if (useStore.getState().activeProjectId === projectId) setError(errorText(e));
    } finally {
      busyRef.current.delete("dispatch");
      setBusy(null);
    }
  }

  async function saveTask(taskId: string): Promise<void> {
    if (busyRef.current.has(`edit:${taskId}`)) return;
    busyRef.current.add(`edit:${taskId}`);
    setBusy(`edit:${taskId}`);
    setError(null);
    try {
      await api.editTask(taskId, {
        title: editDraft.title.trim(),
        instructions: editDraft.instructions.trim(),
        role: editDraft.role.trim() || null,
      });
      setEditing(null);
      await reload();
    } catch (e) {
      if (useStore.getState().activeProjectId === projectId) setError(errorText(e));
    } finally {
      busyRef.current.delete(`edit:${taskId}`);
      setBusy(null);
    }
  }

  if (!projectId) return <div className="pane team"><div className="empty">Open a project to organise work.</div></div>;

  return (
    <div className="pane team" data-testid="team-view">
      <div className="team-hd">
        <span>Team</span>
        <span className="badge subtle">{tasks.filter((t) => t.status === "running").length} running</span>
        <span className="badge subtle">{tasks.length} total</span>
        <button onClick={() => setShowForm((v) => !v)}>{showForm ? "Cancel" : "Dispatch task"}</button>
      </div>
      {error && <div className="hub-error" role="alert">{error}</div>}
      {showForm && (
        <div className="team-form">
          <label>Title<input aria-label="Task title" placeholder="Task name" value={draftTitle} onChange={(e) => setDraftTitle(e.target.value)} /></label>
          <label>Instructions<textarea aria-label="Task instructions" placeholder="What should this task deliver?" value={draftInstructions} onChange={(e) => setDraftInstructions(e.target.value)} /></label>
          <label>Role<input aria-label="Task role" placeholder="Role (optional)" value={draftRole} onChange={(e) => setDraftRole(e.target.value)} /></label>
          <label>Workspace mode
            <select aria-label="Dispatch workspace mode" value={workspaceMode} onChange={(e) => setWorkspaceMode(e.target.value as WorkspaceMode)}>
              <option value="shared">Shared files</option>
              <option value="worktree" disabled={Boolean(worktreeReason) || !hasCompletedAnchor}>Isolated worktree</option>
            </select>
          </label>
          {worktreeReason && <p className="team-note">Worktree unavailable: {worktreeReason}</p>}
          {!hasCompletedAnchor && <p className="team-note">Complete a turn before dispatching an isolated task.</p>}
          <button onClick={() => void dispatch()} disabled={busy === "dispatch" || !draftTitle.trim() || !draftInstructions.trim() || (workspaceMode === "worktree" && Boolean(worktreeReason))}>
            {busy === "dispatch" ? "Dispatching…" : "Dispatch"}
          </button>
          <p className="team-note">A dispatched task gets a persistent branch and a real runtime attempt.</p>
        </div>
      )}
      {tasks.length === 0 && !showForm && <div className="empty">No tasks yet. Dispatch one to start organising work.</div>}
      <div className="team-list">
        {tasks.map((task) => {
          const branch = st.branches.find((b) => b.id === task.branchId);
          const branchRunning = branch ? branchBusy(st, branch.id) : false;
          const running = branchRunning || task.status === "running" || task.status === "queued";
          const meta = RUN_META[task.status] ?? RUN_META.queued;
          return (
            <div className="task-card" key={task.id} data-testid="task-card" data-task-id={task.id}>
              <div className="task-hd">
                <span className={`dot dot-${running ? "running" : meta.dot}`} />
                <button className="task-title" onClick={() => void openTask(task)}>{task.title}</button>
                {task.role && <span className="badge subtle">{task.role}</span>}
                <span className={`badge ${meta.cls === "ok" ? "ok" : meta.cls === "error" ? "err" : "busy"}`}>{task.status}</span>
              </div>
              <div className="task-meta">
                {branch ? <button className="link" onClick={() => onOpenBranch?.(branch.id)} title="Open this task in Chat">Open conversation · {branch.displayName ?? branch.id.slice(0, 4)}</button> : <span className="muted">no branch bound</span>}
                {(branchRunning || task.status === "running") && branch && <button className="task-interrupt" data-testid="task-interrupt" disabled={busy === branch.id} onClick={() => void interruptBranch(branch.id)}>{busy === branch.id ? "Stopping…" : "Interrupt"}</button>}
                {(task.status === "failed" || task.status === "cancelled" || task.status === "queued") && <button className="task-retry" data-testid="task-retry" disabled={busy === task.id} onClick={() => void retryTask(task)}>{task.status === "queued" ? "Start" : "Retry"}</button>}
                <button className="link" onClick={() => {
                  setEditing(editing === task.id ? null : task.id);
                  setEditDraft({ title: task.title, instructions: task.instructions, role: task.role ?? "" });
                }}>{editing === task.id ? "Cancel edit" : "Edit"}</button>
                {task.status === "completed" && <button className="task-apply" data-testid="task-apply" onClick={() => setApplyFor(applyFor === task.id ? null : task.id)} title="Preview applying this task's results to a target directory">Apply…</button>}
              </div>
              {editing === task.id && (
                <div className="team-form task-edit-form">
                  <label>Title<input aria-label="Edit task title" value={editDraft.title} onChange={(e) => setEditDraft((d) => ({ ...d, title: e.target.value }))} /></label>
                  <label>Instructions<textarea aria-label="Edit task instructions" value={editDraft.instructions} onChange={(e) => setEditDraft((d) => ({ ...d, instructions: e.target.value }))} /></label>
                  <label>Role<input aria-label="Edit task role" value={editDraft.role} onChange={(e) => setEditDraft((d) => ({ ...d, role: e.target.value }))} /></label>
                  <button disabled={busy === `edit:${task.id}` || !editDraft.title.trim() || !editDraft.instructions.trim()} onClick={() => void saveTask(task.id)}>{busy === `edit:${task.id}` ? "Saving…" : "Save task"}</button>
                </div>
              )}
              {applyFor === task.id && <ApplyPanel taskId={task.id} onClose={() => setApplyFor(null)} />}
              {expanded === task.id && (
                <div className="task-attempts" data-testid="task-attempts">
                  <div className="task-attempts-hd">Attempts ({attempts.length})</div>
                  {attempts.length === 0 && <div className="empty small">No attempts recorded.</div>}
                  {attempts.map((attempt, index) => (
                    <div className="attempt-row" key={attempt.id}>
                      <span className="badge subtle">#{index + 1}</span>
                      <span className={`badge ${attempt.status === "completed" ? "ok" : attempt.status === "failed" ? "err" : "busy"}`}>{attempt.status}</span>
                      {attempt.error && <span className="attempt-error" title={attempt.error}>{attempt.error}</span>}
                      {attempt.resultRef && <span className="attempt-ref">→ {attempt.resultRef}</span>}
                      {attempt.nodeId && <button className="link" onClick={() => attempt.branchId && onOpenBranch?.(attempt.branchId)}>Open turn</button>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="team-runs">
        <div className="team-runs-hd">Agent runs (this branch)</div>
        {(st.activeBranchId ? st.agentRunsByBranch[st.activeBranchId] ?? [] : []).length === 0 && <div className="empty small">No agent runs on the active branch.</div>}
        {(st.activeBranchId ? st.agentRunsByBranch[st.activeBranchId] ?? [] : []).map((run: AgentRun) => {
          const meta = RUN_META[run.status] ?? RUN_META.queued;
          return <div className="run-line" key={run.id}><span className={`dot dot-${meta.dot}`} /><span>{run.displayLabel ?? run.name ?? run.type}</span>{run.parentAgentRunId && <span className="badge subtle">spawned</span>}<span className="badge subtle">{run.status}</span></div>;
        })}
      </div>
    </div>
  );
}

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
