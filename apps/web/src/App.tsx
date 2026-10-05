// App shell: three-pane layout (Tree / Chat / Monitor) + Timeline bottom.
// Bootstrap and refreshes use the Zustand store as the live source of truth;
// callbacks held by the WebSocket therefore never close over an old render.

import { useEffect, useRef } from "react";
import { useStore } from "./store/useStore";
import { api } from "./api/client";
import { WsStream } from "./lib/ws";
import { ConversationTree } from "./components/ConversationTree";
import { ChatPane } from "./components/ChatPane";
import { AgentMonitor } from "./components/AgentMonitor";
import { Timeline } from "./components/Timeline";

const PENDING_REFRESH_FAST_INTERVAL_MS = 1_500;
const PENDING_REFRESH_SLOW_INTERVAL_MS = 5_000;
const PENDING_REFRESH_FAST_ATTEMPTS = 4;
const EVENT_REFRESH_BATCH_MS = 100;
const STARTUP_RETRY_INTERVAL_MS = 2_000;
const STARTUP_RETRY_ATTEMPTS = 10;

export function App() {
  const st = useStore();
  const streamRef = useRef<WsStream | null>(null);
  const refreshTokenRef = useRef(0);
  const refreshAllTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshInFlightRef = useRef<Promise<void> | null>(null);
  const refreshAgainRef = useRef(false);
  const pendingRefreshRef = useRef<{ timer: ReturnType<typeof setTimeout>; attempts: number } | null>(null);
  const startupRetryRef = useRef<{ timer: ReturnType<typeof setInterval>; attempts: number } | null>(null);
  const bootstrapInFlightRef = useRef<Promise<void> | null>(null);
  const disposedRef = useRef(false);

  useEffect(() => {
    // Reset this flag on effect setup so React StrictMode's development-only
    // setup/cleanup/setup cycle does not strand the first bootstrap promise.
    disposedRef.current = false;
    void bootstrap();
    return () => {
      disposedRef.current = true;
      streamRef.current?.stop();
      if (refreshAllTimerRef.current) clearTimeout(refreshAllTimerRef.current);
      if (pendingRefreshRef.current) clearTimeout(pendingRefreshRef.current.timer);
      if (startupRetryRef.current) clearInterval(startupRetryRef.current.timer);
    };
  }, []);

  // Keep the active branch conversation, node list, run list, and workspace
  // status fresh whenever the user changes branches.
  const activeBranchId = st.activeBranchId;
  useEffect(() => {
    if (!activeBranchId) return;
    void refreshBranchData(activeBranchId);
  }, [activeBranchId]);

  // ChatPane adds an optimistic pending node immediately after POST /messages.
  // That state transition may happen without a WS frame (for example when the
  // runtime warmup or socket startup failed), so observe it directly and start
  // the bounded reconciliation poll from the render that sees it.
  const pendingCount = Object.values(st.nodesByBranch)
    .reduce((count, nodes) => count + nodes.filter((node) => node.status === "pending").length, 0);
  useEffect(() => {
    syncPendingRefresh();
  }, [pendingCount]);

  async function bootstrap(): Promise<void> {
    if (bootstrapInFlightRef.current) return bootstrapInFlightRef.current;
    const run = (async () => {
      try {
        let projects = await api.listProjects();
        if (projects.length === 0) {
          projects = [await api.createProject("Default")];
        }
        useStore.getState().setProjects(projects);
        const project = projects[0];
        useStore.getState().setActiveProject(project.id);

        let branches = await api.listBranches(project.id);
        if (branches.length === 0) {
          const created = await api.createRoot(project.id, "Main", "shared");
          branches = [created.branch];
        }
        useStore.getState().setBranches(branches);
        const main = branches.find((branch) => branch.status === "active") ?? branches[0];
        if (main) {
          useStore.getState().setActiveBranch(main.id);
          await refreshBranchData(main.id);
        }

        try {
          useStore.getState().setAttention(await api.listAttention());
        } catch {
          // Attention is optional during an early runtime start.
        }
        // This is a project-scoped cursor. Branch-scoped events would omit
        // events from sibling branches and cannot seed the project WS stream.
        const events = await api.eventsAfter(project.id, 0);
        useStore.getState().seedTimeline(events.events);

        const stream = new WsStream(project.id, (frame) => {
          useStore.getState().applyFrame(frame);
          // Coalesce the burst of lifecycle/tool frames into one bounded
          // refresh. Every frame still reaches the timeline immediately.
          requestRefreshAll();
          if (frame.type === "session.stopped" && frame.branchId) {
            settleRefresh(frame.branchId);
          }
          syncPendingRefresh();
        }, (status) => {
          useStore.getState().setSocketStatus(status);
        }, () => {
          requestRefreshAll(0);
        });
        streamRef.current?.stop();
        streamRef.current = stream;
        stream.start(events.latestSeqRel);
        stopStartupRetry();
      } catch (error) {
        console.error("bootstrap failed", error);
        // A temporary failure after a project/node has been created must not
        // leave cancellation or terminal state invisible forever. Retry a
        // bounded refresh/bootstrap window while startup is incomplete.
        scheduleStartupRetry();
        syncPendingRefresh();
      }
    })();
    bootstrapInFlightRef.current = run;
    try {
      await run;
    } finally {
      bootstrapInFlightRef.current = null;
    }
  }

  function requestRefreshAll(delay = EVENT_REFRESH_BATCH_MS): void {
    if (disposedRef.current || refreshAllTimerRef.current) return;
    refreshAllTimerRef.current = setTimeout(() => {
      refreshAllTimerRef.current = null;
      void refreshAll();
    }, delay);
  }

  async function refreshAll(): Promise<void> {
    if (refreshInFlightRef.current) {
      refreshAgainRef.current = true;
      return refreshInFlightRef.current;
    }
    const run = (async () => {
      const projectId = useStore.getState().activeProjectId;
      if (!projectId) return;
      try {
        const branches = await api.listBranches(projectId);
        useStore.getState().setBranches(branches);
        try {
          useStore.getState().setAttention(await api.listAttention());
        } catch {
          // Keep branch/conversation refresh useful when attention is down.
        }
        const branchId = useStore.getState().activeBranchId;
        if (branchId) await refreshBranchData(branchId);
      } catch {
        // The socket and bounded pending poll will retry transient failures.
      } finally {
        syncPendingRefresh();
      }
    })();
    refreshInFlightRef.current = run;
    try {
      await run;
    } finally {
      refreshInFlightRef.current = null;
      if (refreshAgainRef.current && !disposedRef.current) {
        refreshAgainRef.current = false;
        requestRefreshAll(0);
      }
    }
  }

  // completeTurn persists the assistant message after session.stopped is
  // forwarded, so a short settle refetch closes that race.
  function settleRefresh(branchId: string): void {
    setTimeout(() => {
      if (disposedRef.current) return;
      void refreshBranchData(branchId);
      void api.listAttention().then((cards) => useStore.getState().setAttention(cards)).catch(() => {});
    }, 300);
  }

  async function refreshBranchData(branchId: string): Promise<void> {
    const token = ++refreshTokenRef.current;
    try {
      const [conversation, nodes, runs, workspace] = await Promise.all([
        api.conversation(branchId),
        api.nodes(branchId),
        api.agentRuns(branchId),
        api.workspace(branchId).catch(() => null),
      ]);
      if (token !== refreshTokenRef.current || disposedRef.current) return;
      const current = useStore.getState();
      current.setConversation(branchId, conversation);
      current.setNodes(branchId, nodes);
      current.setAgentRuns(branchId, runs);
      if (workspace) current.setWorkspace(branchId, workspace);
      syncPendingRefresh();
    } catch {
      // Keep the last coherent branch state during reconnects.
      syncPendingRefresh();
    }
  }

  function syncPendingRefresh(): void {
    const pending = pendingBranchIds().length > 0;
    if (!pending) {
      if (pendingRefreshRef.current) clearTimeout(pendingRefreshRef.current.timer);
      pendingRefreshRef.current = null;
      return;
    }
    if (pendingRefreshRef.current) return;
    const state = { timer: undefined as unknown as ReturnType<typeof setTimeout>, attempts: 0 };
    const poll = async () => {
      if (pendingRefreshRef.current !== state || disposedRef.current) return;
      if (pendingBranchIds().length === 0) {
        pendingRefreshRef.current = null;
        return;
      }
      state.attempts += 1;
      await refreshPendingBranches();
      if (pendingRefreshRef.current !== state || disposedRef.current) return;
      // Keep polling for as long as the server reports a pending node. Warmup
      // and queue delays can exceed a fixed retry budget, so only the cadence
      // changes after a few quick reconciliation attempts.
      if (pendingBranchIds().length === 0) {
        pendingRefreshRef.current = null;
        return;
      }
      const delay = state.attempts <= PENDING_REFRESH_FAST_ATTEMPTS
        ? PENDING_REFRESH_FAST_INTERVAL_MS
        : PENDING_REFRESH_SLOW_INTERVAL_MS;
      state.timer = setTimeout(() => void poll(), delay);
    };
    state.timer = setTimeout(() => void poll(), PENDING_REFRESH_FAST_INTERVAL_MS);
    pendingRefreshRef.current = state;
  }

  function pendingBranchIds(): string[] {
    return Object.entries(useStore.getState().nodesByBranch)
      .filter(([, nodes]) => nodes.some((node) => node.status === "pending"))
      .map(([branchId]) => branchId);
  }

  async function refreshPendingBranches(): Promise<void> {
    for (const branchId of pendingBranchIds()) {
      if (disposedRef.current) return;
      await refreshBranchData(branchId);
    }
  }

  function scheduleStartupRetry(): void {
    if (startupRetryRef.current || disposedRef.current) return;
    const state = { timer: undefined as unknown as ReturnType<typeof setInterval>, attempts: 0 };
    state.timer = setInterval(() => {
      state.attempts += 1;
      if (state.attempts >= STARTUP_RETRY_ATTEMPTS) {
        clearInterval(state.timer);
        startupRetryRef.current = null;
        return;
      }
      if (streamRef.current) {
        requestRefreshAll(0);
      } else {
        void bootstrap();
      }
    }, STARTUP_RETRY_INTERVAL_MS);
    startupRetryRef.current = state;
  }

  function stopStartupRetry(): void {
    if (startupRetryRef.current) clearInterval(startupRetryRef.current.timer);
    startupRetryRef.current = null;
  }

  const project = st.projects.find((item) => item.id === st.activeProjectId) ?? st.projects[0];
  const socketStatus = st.socketStatus;

  return (
    <div className="app">
      <header className="app-hd">
        <strong>Claude Branch Workspace</strong>
        <span className={`dot dot-${socketStatus === "open" ? "ok" : socketStatus === "connecting" ? "running" : "error"}`} />
        <span className="socket-txt">
          {socketStatus === "open" ? "connected" : socketStatus === "connecting" ? "connecting…" : "offline"}
        </span>
        {project && (
          <span className="project-name" title={project.rootPath ?? undefined}>
            {project.name}
            <span className="project-root">{project.rootPath ?? "root path not set"}</span>
          </span>
        )}
      </header>
      <div className="layout">
        <ConversationTree />
        <ChatPane />
        <AgentMonitor />
      </div>
      <Timeline />
    </div>
  );
}
