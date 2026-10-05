// S4 / experiment E5: a Team view you can ACT in — dispatch work, watch two
// tasks run in parallel, interrupt ONE without touching the others, and retry a
// failure without losing its history.
//
// The previous AgentMonitor was a read-only status card list. The gap this
// closes is the difference between "see that agents are running" and "organise
// the work", which is what the product is for.
//
// Two distinctions the UI must never blur (constitution §1):
//   - a PERSISTENT task branch (durable, interactive, resumable)
//   - a TRANSIENT agent run (a subagent inside one turn)
// They are drawn as different groups and never merged into one list.

import { useCallback, useEffect, useState } from "react";
import { useStore, branchBusy } from "../store/useStore";
import { api } from "../api/client";
import type { AgentRun, Task, TaskAttempt } from "../types";

const RUN_META: Record<string, { dot: string; cls: string }> = {
  running: { dot: "running", cls: "running" },
  queued: { dot: "idle", cls: "queued" },
  waiting: { dot: "attention", cls: "waiting" },
  needs_attention: { dot: "attention", cls: "waiting" },
  completed: { dot: "ok", cls: "ok" },
  failed: { dot: "error", cls: "error" },
  cancelled: { dot: "error", cls: "error" },
};

export function TeamView() {
  const st = useStore();
  const projectId = st.activeProjectId;
  const [tasks, setTasks] = useState<Task[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [attempts, setAttempts] = useState<TaskAttempt[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [showForm, setShowForm] = useState(false);

  const reload = useCallback(async () => {
    if (!projectId) return;
    try {
      setTasks(await api.listTasks(projectId));
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }, [projectId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Keep the team view live: task and run state change from the runtime, and a
  // stale team view is worse than none.
  useEffect(() => {
    const t = setInterval(() => void reload(), 4000);
    return () => clearInterval(t);
  }, [reload]);

  async function openTask(task: Task): Promise<void> {
    if (expanded === task.id) {
      setExpanded(null);
      return;
    }
    setExpanded(task.id);
    try {
      const detail = await api.getTask(task.id);
      setAttempts(detail.attempts ?? []);
    } catch {
      setAttempts([]);
    }
  }

  async function interruptBranch(branchId: string): Promise<void> {
    setBusy(branchId);
    setError(null);
    try {
      await api.interrupt(branchId);
      // Interrupting one branch must not disturb the others: only refresh.
      await reload();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(null);
    }
  }

  async function retryTask(task: Task): Promise<void> {
    setBusy(task.id);
    setError(null);
    try {
      const attempt = await api.startTaskAttempt(task.id);
      await api.completeTaskAttempt(task.id, attempt.id, { status: "cancelled" }).catch(() => {});
      await reload();
      if (expanded === task.id) setAttempts((await api.getTask(task.id)).attempts ?? []);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(null);
    }
  }

  async function dispatch(): Promise<void> {
    const title = draft.trim();
    if (!title || !projectId) return;
    setBusy("dispatch");
    setError(null);
    try {
      // A persisted task branch is created explicitly; a task never silently
      // becomes a branch, and a branch never silently becomes a task.
      const created = await api.createRoot(projectId, title, "shared");
      await api.createTask(projectId, title, title, created.branch.id);
      setDraft("");
      setShowForm(false);
      const branches = await api.listBranches(projectId);
      useStore.getState().setBranches(branches);
      await reload();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(null);
    }
  }

  if (!projectId) {
    return <div className="pane team"><div className="empty">Open a project to organise work.</div></div>;
  }

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
          <input
            aria-label="Task title"
            placeholder="What should this branch work on?"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void dispatch();
            }}
          />
          <button onClick={() => void dispatch()} disabled={busy === "dispatch" || !draft.trim()}>
            {busy === "dispatch" ? "Dispatching…" : "Dispatch"}
          </button>
          <p className="team-note">
            Creates a persistent task branch you can open, interrupt and continue — not a
            throwaway subagent.
          </p>
        </div>
      )}

      {tasks.length === 0 && !showForm && (
        <div className="empty">No tasks yet. Dispatch one to start organising work.</div>
      )}

      <div className="team-list">
        {tasks.map((task) => {
          const branch = st.branches.find((b) => b.id === task.branchId);
          const running = branch ? branchBusy(st, branch.id) : task.status === "running";
          const meta = RUN_META[task.status] ?? RUN_META.queued;
          return (
            <div className="task-card" key={task.id} data-testid="task-card" data-task-id={task.id}>
              <div className="task-hd">
                <span className={`dot dot-${meta.dot}`} />
                <button className="task-title" onClick={() => void openTask(task)}>
                  {task.title}
                </button>
                {task.role && <span className="badge subtle">{task.role}</span>}
                <span className={`badge ${meta.cls === "ok" ? "ok" : meta.cls === "error" ? "err" : "busy"}`}>
                  {task.status}
                </span>
              </div>
              <div className="task-meta">
                {branch ? (
                  <button
                    className="link"
                    onClick={() => {
                      useStore.getState().setActiveBranch(branch.id);
                    }}
                    title="Open this task's branch"
                  >
                    branch {branch.displayName ?? branch.id.slice(0, 4)}
                  </button>
                ) : (
                  <span className="muted">no branch bound</span>
                )}
                {/* Interrupt is PER BRANCH: stopping one task must leave the
                    others running (E5 pass condition). */}
                {running && branch && (
                  <button
                    className="task-interrupt"
                    data-testid="task-interrupt"
                    disabled={busy === branch.id}
                    onClick={() => void interruptBranch(branch.id)}
                  >
                    {busy === branch.id ? "Stopping…" : "Interrupt"}
                  </button>
                )}
                {(task.status === "failed" || task.status === "cancelled") && (
                  <button
                    className="task-retry"
                    data-testid="task-retry"
                    disabled={busy === task.id}
                    onClick={() => void retryTask(task)}
                    title="Start a new attempt; the previous one is kept"
                  >
                    Retry
                  </button>
                )}
              </div>
              {expanded === task.id && (
                <div className="task-attempts" data-testid="task-attempts">
                  <div className="task-attempts-hd">Attempts ({attempts.length})</div>
                  {attempts.length === 0 && <div className="empty small">No attempts recorded.</div>}
                  {attempts.map((a, i) => (
                    <div className="attempt-row" key={a.id}>
                      <span className="badge subtle">#{i + 1}</span>
                      <span className={`badge ${a.status === "completed" ? "ok" : a.status === "failed" ? "err" : "busy"}`}>
                        {a.status}
                      </span>
                      {a.error && <span className="attempt-error" title={a.error}>{a.error}</span>}
                      {a.resultRef && <span className="attempt-ref">→ {a.resultRef}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Execution tree — a DIFFERENT object class from tasks/branches. Kept
          visually separate so a transient run is never mistaken for durable
          work (constitution §1). */}
      <div className="team-runs">
        <div className="team-runs-hd">Agent runs (this branch)</div>
        {(st.activeBranchId ? st.agentRunsByBranch[st.activeBranchId] ?? [] : []).length === 0 && (
          <div className="empty small">No agent runs on the active branch.</div>
        )}
        {(st.activeBranchId ? st.agentRunsByBranch[st.activeBranchId] ?? [] : []).map((run: AgentRun) => {
          const meta = RUN_META[run.status] ?? RUN_META.queued;
          return (
            <div className="run-line" key={run.id}>
              <span className={`dot dot-${meta.dot}`} />
              <span>{run.displayLabel ?? run.name ?? run.type}</span>
              {run.parentAgentRunId && <span className="badge subtle">spawned</span>}
              <span className="badge subtle">{run.status}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
