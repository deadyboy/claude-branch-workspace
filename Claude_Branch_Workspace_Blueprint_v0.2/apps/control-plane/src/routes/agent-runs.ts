// AgentRun / execution-tree routes (constitution two-tree separation: transient
// AgentRuns display under their node's turn; they are NEVER promoted to
// branches). Attribution-honest surface (gate 9): runs carry their branch/node.

import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";

export function registerAgentRuns(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/branches/:id/agent-runs", async (req) => {
    const { id } = req.params as { id: string };
    return ctx.svc.listAgentRunsByBranch(id);
  });

  app.get("/api/agent-runs/:id", async (req) => {
    const { id } = req.params as { id: string };
    const r = ctx.svc.getAgentRun(id);
    if (!r) return { error: "agent run not found" };
    return r;
  });

  app.get("/api/branches/:id/execution-tree", async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { nodeId?: string };
    const tree = ctx.svc.getExecutionTree(id, q.nodeId ?? null);
    if (!tree) return { error: "no execution tree" };
    return tree;
  });
}
