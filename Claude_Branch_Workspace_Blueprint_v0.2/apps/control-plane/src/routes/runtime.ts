// Runtime routes (docs/10): honest capabilities, session registry overview, and
// an on-demand reconcile sweep (gate 15 — the boot sweep still runs in index.ts).

import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { reconcileOnBoot } from "../reconcile.js";

export function registerRuntime(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/runtime/capabilities", async () => {
    const caps = await ctx.adapter.getCapabilities();
    return { capabilities: caps, mode: "shared" };
  });

  app.get("/api/runtime/sessions", async () => {
    const live = ctx.sessionManager.listStates().map((s) => ({
      branchId: s.branchId,
      sessionKey: s.sessionKey,
      busy: ctx.sessionManager.isBusy(s.branchId),
    }));
    // Persisted mapping is the restart fact (g13); the session manager is the
    // sole writer, so the live view IS the authoritative in-process surface.
    return { live };
  });

  app.post("/api/runtime/reconcile", async () => {
    return reconcileOnBoot(ctx.svc);
  });
}
