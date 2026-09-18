// Runtime routes (docs/10): honest capabilities, session registry overview, and
// an on-demand reconcile sweep (gate 15 — the boot sweep still runs in index.ts).

import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { reconcileOnBoot } from "../reconcile.js";

export function registerRuntime(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/runtime/capabilities", async () => {
    const caps = await ctx.adapter.getCapabilities();
    return { capabilities: caps, modes: ctx.workspaceManager ? ["shared", "worktree"] : ["shared"], scheduler: ctx.scheduler?.snapshot() ?? null };
  });

  app.get("/api/runtime/sessions", async () => {
    const live = ctx.sessionManager.listStates().map((s) => ({
      branchId: s.branchId,
      sessionKey: s.sessionKey,
      busy: ctx.sessionManager.hasActiveTurn(s.branchId),
    }));
    // Persisted mapping is the restart fact (g13); the session manager is the
    // sole writer, so the live view IS the authoritative in-process surface.
    return { live };
  });

  app.post("/api/runtime/reconcile", async (_req, reply) => {
    if (ctx.scheduler && (ctx.scheduler.snapshot().running.length || ctx.scheduler.snapshot().queued.length)) {
      return reply.code(409).send({ error: "cannot reconcile while turns are active" });
    }
    if (ctx.sessionManager.listStates().some(s => ctx.sessionManager.hasActiveTurn(s.branchId))) {
      return reply.code(409).send({ error: "cannot reconcile while turns are active" });
    }
    return reconcileOnBoot(ctx.svc);
  });

  app.get("/api/runtime/scheduler", async () => ctx.scheduler?.snapshot() ?? { running: [], queued: [] });
  app.get("/api/branches/:id/workspace", async (req, reply) => {
    if (!ctx.workspaceManager) return reply.code(501).send({ error: "workspace management unavailable" });
    const { id } = req.params as { id: string };
    if (!ctx.svc.getBranch(id)) return reply.code(404).send({ error: "branch not found" });
    return ctx.workspaceManager.status(id);
  });
  app.post("/api/branches/:id/workspace/cleanup", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!ctx.workspaceManager) return reply.code(501).send({ error: "workspace management unavailable" });
    if (ctx.sessionManager.hasActiveTurn(id)) return reply.code(409).send({ error: "branch is busy" });
    try { await ctx.workspaceManager.cleanup(id); return { cleaned: true }; }
    catch { return reply.code(409).send({ error: "cleanup refused: archive first and preserve changes or unmerged commits" }); }
  });
}
