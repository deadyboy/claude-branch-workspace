// Node routes (docs/10): turns under a branch, single-node reads.

import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";

export function registerNodes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/branches/:id/nodes", async (req) => {
    const { id } = req.params as { id: string };
    return ctx.repo.listNodesByBranch(id);
  });

  app.get("/api/nodes/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const n = ctx.svc.getNode(id);
    if (!n) return reply.code(404).send({ error: "node not found" });
    return n;
  });
}
