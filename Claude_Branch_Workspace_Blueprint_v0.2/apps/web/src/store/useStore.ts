// Zustand store. Slices per plan: branches (tree/active/fork), conversation
// (effective items + origin), toolCards (grouped by node/turn), agentMonitor,
// timeline (filters), attention, socket.

import { create } from "zustand";
import { api } from "../api/client";
import type {
  Branch,
  Project,
  ConversationNode,
  EffectiveConversationItem,
  AgentRun,
  AttentionCard,
  AttentionCardWire,
  EventFrame,
} from "../types";

export type ToolCardState = "running" | "ok" | "error" | "done";

export interface ToolCard {
  id: string;
  branchId: string;
  nodeId: string | null;
  agentRunId: string | null;
  name: string;
  input: unknown;
  output?: unknown;
  state: ToolCardState;
  startedAt: string;
}

export interface TimelineEntry {
  eventId: string;
  seqRel: number;
  type: string;
  status: string | null;
  branchId: string | null;
  nodeId: string | null;
  agentRunId: string | null;
  occurredAt: string;
  payload: unknown;
}

interface CbwState {
  // ---- projects / branches ----
  projects: Project[];
  branches: Branch[];
  activeProjectId: string | null;
  activeBranchId: string | null;
  // node status per branch (for busy flag + badges)
  nodesByBranch: Record<string, ConversationNode[]>;
  // effective conversation per branch
  conversationByBranch: Record<string, EffectiveConversationItem[]>;
  // ---- agent runs ----
  agentRunsByBranch: Record<string, AgentRun[]>;
  // ---- tool cards (grouped per node/turn) ----
  toolCards: ToolCard[];
  // ---- timeline (all project events) ----
  timeline: TimelineEntry[];
  latestSeqRel: number;
  timelineFilter: "all" | "errors" | "permission" | "tools";
  pauseAutoscroll: boolean;
  collapseRepeatedTools: boolean;
  // ---- attention ----
  attention: AttentionCard[];
  // ---- socket ----
  socketStatus: "connecting" | "open" | "closed";

  // ---- actions ----
  setProjects: (p: Project[]) => void;
  setActiveProject: (id: string | null) => void;
  setBranches: (b: Branch[]) => void;
  setActiveBranch: (id: string) => void;
  setNodes: (branchId: string, nodes: ConversationNode[]) => void;
  setConversation: (branchId: string, items: EffectiveConversationItem[]) => void;
  setAgentRuns: (branchId: string, runs: AgentRun[]) => void;
  setAttention: (cards: AttentionCardWire[]) => void;
  setSocketStatus: (s: "connecting" | "open" | "closed") => void;
  setTimelineFilter: (f: "all" | "errors" | "permission" | "tools") => void;
  setPauseAutoscroll: (b: boolean) => void;
  setCollapseRepeatedTools: (b: boolean) => void;
  applyFrame: (f: EventFrame) => void;
  seedTimeline: (events: EventFrame[]) => void;
  respondAttention: (id: string, answer: "allow" | "deny") => Promise<void>;
}

const statusIsError = (s: string | null): boolean =>
  s === "failed" || s === "cancelled" || (s !== null && s.toLowerCase().includes("error"));

const statusSuggestsPermission = (t: TimelineEntry): boolean =>
  ["permission.requested", "attention.required", "needs_attention"].includes(t.type) ||
  t.status === "needs_attention" ||
  t.status === "permission.requested" ||
  t.status === "attention.required";

export const useStore = create<CbwState>((set, get) => ({
  projects: [],
  branches: [],
  activeProjectId: null,
  activeBranchId: null,
  nodesByBranch: {},
  conversationByBranch: {},
  agentRunsByBranch: {},
  toolCards: [],
  timeline: [],
  latestSeqRel: 0,
  timelineFilter: "all",
  pauseAutoscroll: false,
  collapseRepeatedTools: false,
  attention: [],
  socketStatus: "closed",

  setProjects: (projects) => set({ projects }),
  setActiveProject: (activeProjectId) => set({ activeProjectId }),
  setBranches: (branches) => set({ branches }),
  setActiveBranch: (activeBranchId) => set({ activeBranchId }),
  setNodes: (branchId, nodes) =>
    set((s) => ({ nodesByBranch: { ...s.nodesByBranch, [branchId]: nodes } })),
  setConversation: (branchId, items) =>
    set((s) => ({ conversationByBranch: { ...s.conversationByBranch, [branchId]: items } })),
  setAgentRuns: (branchId, runs) =>
    set((s) => ({ agentRunsByBranch: { ...s.agentRunsByBranch, [branchId]: runs } })),
  setAttention: (attention) => set({ attention: attention.map(toUiCard) }),
  setSocketStatus: (socketStatus) => set({ socketStatus }),
  setTimelineFilter: (timelineFilter) => set({ timelineFilter }),
  setPauseAutoscroll: (pauseAutoscroll) => set({ pauseAutoscroll }),
  setCollapseRepeatedTools: (collapseRepeatedTools) => set({ collapseRepeatedTools }),

  seedTimeline: (frames) => {
    const seen = new Set(get().timeline.map((t) => t.eventId));
    const merged = [...get().timeline];
    let maxRel = get().latestSeqRel;
    for (const f of frames) {
      if (seen.has(f.eventId)) continue;
      seen.add(f.eventId);
      merged.push(timelineEntry(f));
      if (f.seqRel > maxRel) maxRel = f.seqRel;
    }
    merged.sort((a, b) => a.seqRel - b.seqRel);
    set({ timeline: merged, latestSeqRel: maxRel });
  },

  applyFrame: (f) => {
    // Timeline.
    const existing = get().timeline;
    const idx = existing.findIndex((t) => t.eventId === f.eventId);
    const entry = timelineEntry(f);
    const timeline =
      idx >= 0 ? existing.map((t, i) => (i === idx ? entry : t)) : [...existing, entry].sort((a, b) => a.seqRel - b.seqRel);
    const latestSeqRel = Math.max(get().latestSeqRel, f.seqRel || 0);

    // Tool cards: derive running/done cards from tool.started/tool.completed
    // events (redacted payload only — never fabricate content).
    let toolCards = get().toolCards;
    if (f.type === "tool.started") {
      const name = String((f.payload as Record<string, unknown>)?.name ?? "tool");
      toolCards = [
        ...toolCards,
        {
          id: f.eventId,
          branchId: f.branchId ?? "",
          nodeId: f.nodeId,
          agentRunId: f.agentRunId,
          name,
          input: (f.payload as Record<string, unknown>)?.input,
          state: "running",
          startedAt: f.occurredAt,
        },
      ];
    } else if (f.type === "tool.completed" || f.type === "tool.error") {
      const doneId = String((f.payload as Record<string, unknown>)?.toolUseId ?? "");
      toolCards = toolCards.map((c) =>
        c.id === doneId || (c.name && doneId && c.name === doneId)
          ? {
              ...c,
              state: f.type === "tool.error" ? "error" : "ok",
              output: (f.payload as Record<string, unknown>)?.output,
            }
          : c
      );
    }

    set({ timeline, latestSeqRel, toolCards });
  },

  respondAttention: async (id, answer) => {
    const updated = await api.respondAttention(id, answer);
    set((s) => ({
      attention: s.attention.map((c) => (c.id === id ? { ...c, status: "answered", answer } : c)),
    }));
    void updated;
  },
}));

// Normalize the server's attention wire shape into what the UI renders.
function toUiCard(c: AttentionCardWire): AttentionCard {
  return {
    id: c.attentionId,
    branchId: c.branchId,
    kind: c.type === "permission" ? "permission" : "attention",
    title: c.requestText,
    status: c.status,
    answer: c.answer,
    createdAt: c.createdAt,
  };
}

function timelineEntry(f: EventFrame): TimelineEntry {
  return {
    eventId: f.eventId,
    seqRel: f.seqRel,
    type: f.type,
    status: f.status,
    branchId: f.branchId,
    nodeId: f.nodeId,
    agentRunId: f.agentRunId,
    occurredAt: f.occurredAt,
    payload: f.payload,
  };
}

// ---- selectors / derived helpers used by components ----

export function branchBusy(s: CbwState, branchId: string): boolean {
  const nodes = s.nodesByBranch[branchId] ?? [];
  return nodes.some((n) => n.status === "pending");
}

export function branchLastNode(s: CbwState, branchId: string): ConversationNode | null {
  const nodes = s.nodesByBranch[branchId] ?? [];
  return nodes.length ? nodes[nodes.length - 1] : null;
}

export function filteredTimeline(s: CbwState): TimelineEntry[] {
  const tl = s.timeline;
  switch (s.timelineFilter) {
    case "errors":
      return tl.filter((t) => statusIsError(t.status));
    case "permission":
      return tl.filter((t) => statusSuggestsPermission(t));
    case "tools":
      return tl.filter((t) => t.type.startsWith("tool."));
    case "all":
    default:
      return tl;
  }
}

export { statusIsError };
