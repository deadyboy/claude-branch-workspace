// REST client for the control plane. All relative to the same origin — in dev
// Vite proxies /api to 127.0.0.1:15723; in prod Fastify serves this SPA.
// Same-origin by construction (gate 12); no credentials/tokens ever per §11.

import type {
  Project,
  Branch,
  EffectiveConversationItem,
  ConversationNode,
  AgentRun,
  AttentionCardWire,
  EventFrame,
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

export const api = {
  // ---- projects ----
  listProjects: () => req<Project[]>("/api/projects"),
  createProject: (name: string) =>
    req<Project>("/api/projects", { method: "POST", body: JSON.stringify({ name }) }),

  // ---- branches ----
  listBranches: (projectId: string) => req<Branch[]>(`/api/projects/${projectId}/branches`),
  createRoot: (projectId: string, displayName?: string) =>
    req<CreatedBranch>("/api/branches", {
      method: "POST",
      body: JSON.stringify({ projectId, displayName: displayName ?? "Main" }),
    }),
  createFork: (projectId: string, forkFromNodeId: string, displayName?: string) =>
    req<CreatedBranch>("/api/branches", {
      method: "POST",
      body: JSON.stringify({ projectId, forkFromNodeId, displayName: displayName ?? null }),
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
  eventsAfter: (branchId: string, after: number) =>
    req<{ events: EventFrame[]; latestSeqRel: number }>(
      `/api/branches/${branchId}/events?after=${after}`
    ),
};
