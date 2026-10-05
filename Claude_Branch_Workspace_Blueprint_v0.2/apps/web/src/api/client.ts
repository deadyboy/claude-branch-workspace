// REST client for the control plane. All relative to the same origin — in dev
// Vite proxies /api to 127.0.0.1:15723; in prod Fastify serves this SPA.
// Same-origin by construction (gate 12); no credentials/tokens ever per §11.

import type {
  Project,
  Host,
  ProjectCapabilities,
  Branch,
  EffectiveConversationItem,
  ConversationNode,
  AgentRun,
  AttentionCardWire,
  EventFrame,
  WorkspaceMode,
  WorkspaceStatus,
} from "../types";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${res.url}: ${body}`);
  }
  return (await res.json()) as T;
}

export interface CreatedBranch {
  branch: Branch;
  snapshot: unknown;
  sessionKey: string | null;
  strategy: string;
}

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null;

function firstString(row: JsonRecord, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function firstNumber(row: JsonRecord, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function parseRedactedPayload(value: unknown): unknown {
  if (value !== undefined && typeof value !== "string") return value;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * Normalize both live WS frames and persisted domain rows. The REST event
 * endpoint returns persisted rows with `id` and `payloadJsonRedacted`, while
 * the socket already uses the public EventFrame names.
 */
export function normalizeEventFrame(raw: unknown): EventFrame | null {
  if (!isRecord(raw)) return null;
  const eventId = firstString(raw, "eventId", "id");
  const projectId = firstString(raw, "projectId", "project_id");
  if (!eventId || !projectId) return null;
  const type = firstString(raw, "type", "eventType") ?? "unknown";
  const occurredAt = firstString(raw, "occurredAt", "occurred_at", "createdAt") ?? new Date().toISOString();
  const status = firstString(raw, "status");
  const seqRel = firstNumber(raw, "seqRel", "seq_rel") ?? 0;
  return {
    eventId,
    seqRel,
    type,
    status,
    projectId,
    branchId: firstString(raw, "branchId", "branch_id"),
    nodeId: firstString(raw, "nodeId", "node_id"),
    agentRunId: firstString(raw, "agentRunId", "agent_run_id"),
    runtimeSessionId: firstString(raw, "runtimeSessionId", "runtime_session_id"),
    occurredAt,
    payload: parseRedactedPayload(raw.payload ?? raw.payloadJsonRedacted ?? raw.payload_json_redacted),
  };
}

export const api = {
  // ---- execution host (S0 §3) ----
  host: () => req<Host>("/api/host"),

  // ---- projects ----
  listProjects: () => req<Project[]>("/api/projects"),
  createProject: (name: string, rootPath?: string) =>
    req<Project>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name, ...(rootPath ? { rootPath } : {}) }),
    }),
  updateProject: (id: string, patch: { name?: string; rootPath?: string }) =>
    req<Project>(`/api/projects/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  // Workspace modes this project can actually offer, with the real reason when
  // worktree is unavailable (never a bare disabled control).
  capabilities: (id: string) => req<ProjectCapabilities>(`/api/projects/${id}/capabilities`),

  // ---- branches ----
  listBranches: (projectId: string) => req<Branch[]>(`/api/projects/${projectId}/branches`),
  createRoot: (projectId: string, displayName?: string, workspaceMode: WorkspaceMode = "shared") =>
    req<CreatedBranch>("/api/branches", {
      method: "POST",
      body: JSON.stringify({ projectId, displayName: displayName ?? "Main", workspaceMode }),
    }),
  createFork: (
    projectId: string,
    forkFromNodeId: string,
    displayName?: string,
    workspaceMode: WorkspaceMode = "shared"
  ) =>
    req<CreatedBranch>("/api/branches", {
      method: "POST",
      body: JSON.stringify({
        projectId,
        forkFromNodeId,
        displayName: displayName ?? null,
        workspaceMode,
      }),
    }),
  renameBranch: (id: string, displayName: string) =>
    req<Branch>(`/api/branches/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ displayName }),
    }),
  archiveBranch: (id: string) => req<Branch>(`/api/branches/${id}/archive`, { method: "POST" }),
  getAncestry: (id: string) =>
    req<{ branchId: string; ancestors: { id: string; displayName: string | null }[] }>(
      `/api/branches/${id}/ancestry`
    ),
  node: (id: string) => req<ConversationNode>(`/api/nodes/${id}`),
  workspace: (id: string) => req<WorkspaceStatus>(`/api/branches/${id}/workspace`),

  // ---- conversation / nodes (gate 3) ----
  conversation: (branchId: string) =>
    req<EffectiveConversationItem[]>(`/api/branches/${branchId}/conversation`),
  nodes: (branchId: string) => req<ConversationNode[]>(`/api/branches/${branchId}/nodes`),

  // ---- turns (gate 5) / interrupt (gate 6) ----
  sendMessage: (branchId: string, text: string) =>
    req<{ nodeId: string }>(`/api/branches/${branchId}/messages`, {
      method: "POST",
      body: JSON.stringify({ text }),
    }),
  interrupt: (branchId: string) =>
    req<{ interrupted: string }>(`/api/branches/${branchId}/interrupt`, { method: "POST" }),

  // ---- agent runs (execution tree, gate 9) ----
  agentRuns: (branchId: string) => req<AgentRun[]>(`/api/branches/${branchId}/agent-runs`),

  // ---- attention (gate 7). Wire shape from the server; the store normalizes
  // to the UI AttentionCard (id/kind/title) at the boundary. ----
  listAttention: () => req<AttentionCardWire[]>("/api/attention"),
  respondAttention: (id: string, answer: "allow" | "deny") =>
    req<AttentionCardWire>(`/api/attention/${id}/respond`, {
      method: "POST",
      body: JSON.stringify({ answer }),
    }),

  // ---- events (gate 8, REST catch-up) ----
  eventsAfter: async (projectId: string, after: number, limit = 1000) => {
    const body = await req<{ events: unknown[]; latestSeqRel: number }>(
      `/api/projects/${projectId}/events?after=${encodeURIComponent(String(after))}&limit=${encodeURIComponent(String(limit))}`
    );
    return {
      events: body.events.map(normalizeEventFrame).filter((event): event is EventFrame => event !== null),
      latestSeqRel: Number.isFinite(body.latestSeqRel) ? body.latestSeqRel : after,
    };
  },
};
