// Project routes (docs/10): create + read projects.

import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";

export function registerProjects(app: FastifyInstance, ctx: AppContext): void {
  app.post("/api/projects", async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string };
    if (!body.name || typeof body.name !== "string") {
      return reply.code(400).send({ error: "name is required" });
    }
    const p = ctx.svc.createProject({ name: body.name });
    return reply.code(201).send(p);
  });

  app.get("/api/projects/:id", async (req) => {
    const { id } = req.params as { id: string };
    const p = ctx.svc.getProject(id);
    if (!p) return { error: "project not found" };
    return p;
  });

  app.get("/api/projects", async () => {
    return ctx.svc.listProjects();
  });
}
