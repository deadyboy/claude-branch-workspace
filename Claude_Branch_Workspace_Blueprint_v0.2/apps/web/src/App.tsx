// App shell: three-pane layout (Tree / Chat / Monitor) + Timeline bottom.
// Bootstraps: list or create first project, load branches, start the WS stream
// (gate 8), wire reconnect catch-up, subscribe attention, refetch conversation.

import { useEffect, useRef } from "react";
import { useStore } from "./store/useStore";
import { api } from "./api/client";
import { WsStream } from "./lib/ws";
import { ConversationTree } from "./components/ConversationTree";
import { ChatPane } from "./components/ChatPane";
import { AgentMonitor } from "./components/AgentMonitor";
import { Timeline } from "./components/Timeline";

export function App() {
  const st = useStore();
  const streamRef = useRef<WsStream | null>(null);
  // Monotonic refresh guard: only the latest refreshBatch applies its results,
  // so a slow earlier fetch can never clobber fresher state with stale data
  // (the WS frames can trigger several refreshes per turn).
  const refreshTokenRef = useRef(0);

  // One bootstrap only.
  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    void bootstrap();
  }, []);

  // Keep components subscribed to the active branch fresh.
  const activeBranchId = st.activeBranchId;
  useEffect(() => {
    if (!activeBranchId) return;
    void refreshBranchData(activeBranchId);
  }, [activeBranchId]);

  async function bootstrap() {
    try {
      let projects = await api.listProjects();
      if (projects.length === 0) {
        projects = [await api.createProject("Default")];
      }
      st.setProjects(projects);
      const p = projects[0];
      st.setActiveProject(p.id);

      let branches = await api.listBranches(p.id);
      if (branches.length === 0) {
        const created = await api.createRoot(p.id, "Main");
        branches = [created.branch];
      }
      st.setBranches(branches);
      const main = branches.find((b) => b.status === "active") ?? branches[0];
      if (main) {
        st.setActiveBranch(main.id);
        await refreshBranchData(main.id);
      }

      // Seed attention + events, then open the live stream.
      try {
        st.setAttention(await api.listAttention());
      } catch { /* attention optional */ }
      const events = await api.eventsAfter(p.id, 0);
      st.seedTimeline(events.events);

      const stream = new WsStream(p.id, (f) => {
        st.applyFrame(f);
        // Refresh pieces lazily as relevant events arrive.
        if (f.nodeId) void refreshAll();
        // A turn ends with session.stopped — but completeTurn persists the
        // assistant message and terminal node AFTER that frame is forwarded, so
        // the frame's own refresh races it. Settle once, then re-fetch the
        // branch so the UI converges on the final conversation/nodes.
        if (f.type === "session.stopped" && f.branchId) {
          void settleRefresh(f.branchId);
        }
      }, (s) => st.setSocketStatus(s), () => {
        void refreshAll();
      });
      streamRef.current = stream;
      stream.start(events.latestSeqRel);
    } catch (e) {
      console.error("bootstrap failed", e);
    }
  }

  async function refreshAll() {
    if (!st.activeProjectId) return;
    try {
      const branches = await api.listBranches(st.activeProjectId);
      st.setBranches(branches);
      st.setAttention(await api.listAttention());
      if (st.activeBranchId) await refreshBranchData(st.activeBranchId);
    } catch { /* ignore transient */ }
  }

  // The runtime ends a turn with a session.stopped frame, but completeTurn
  // persists the assistant text and terminal node AFTER that frame is bridged,
  // so frame-triggered refreshes race it. A short settle, then a guarded
  // refetch, guarantees the UI converges on the final conversation/nodes.
  function settleRefresh(branchId: string): void {
    setTimeout(() => {
      void refreshBranchData(branchId);
      // a turn may have seeded an attention card (gate 7) — refresh those too
      void api.listAttention().then(st.setAttention).catch(() => {});
    }, 300);
  }

  async function refreshBranchData(branchId: string) {
    const token = ++refreshTokenRef.current;
    try {
      const [conversation, nodes, runs] = await Promise.all([
        api.conversation(branchId),
        api.nodes(branchId),
        api.agentRuns(branchId),
      ]);
      if (token !== refreshTokenRef.current) return; // superseded by a newer refresh
      st.setConversation(branchId, conversation);
      st.setNodes(branchId, nodes);
      st.setAgentRuns(branchId, runs);
    } catch { /* ignore transient */ }
  }

  const socketStatus = st.socketStatus;

  return (
    <div className="app">
      <header className="app-hd">
        <strong>Claude Branch Workspace</strong>
        <span className={`dot dot-${socketStatus === "open" ? "ok" : socketStatus === "connecting" ? "running" : "error"}`} />
        <span className="socket-txt">
          {socketStatus === "open" ? "connected" : socketStatus === "connecting" ? "connecting…" : "offline"}
        </span>
        {st.projects[0] && <span className="project-name">{st.projects[0].name}</span>}
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
