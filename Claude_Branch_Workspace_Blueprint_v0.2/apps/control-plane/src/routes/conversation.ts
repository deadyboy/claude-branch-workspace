// Effective-conversation read model (gate 3): inherited (through the fork
// point) + local messages, each with origin metadata.

import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";

export function registerConversation(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/branches/:id/conversation", async (req) => {
    const { id } = req.params as { id: string };
    if (!ctx.svc.getBranch(id)) return { error: "branch not found" };
    return ctx.svc.getEffectiveConversation(id);
  });
}
