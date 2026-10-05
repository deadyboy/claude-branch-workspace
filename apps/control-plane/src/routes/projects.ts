// Project routes (docs/10): create + read projects.

import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { resolve, isAbsolute } from "node:path";
import { stat } from "node:fs/promises";

export function registerProjects(app: FastifyInstance, ctx: AppContext): void {
  app.post("/api/projects", async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string; rootPath?: string };
    if (!body.name || typeof body.name !== "string") {
      return reply.code(400).send({ error: "name is required" });
    }
    const rootPath = body.rootPath ?? process.cwd();
    if (typeof rootPath !== "string" || !isAbsolute(rootPath) || !(await stat(rootPath).catch(() => null))?.isDirectory()) {
      return reply.code(400).send({ error: "rootPath must be an existing absolute directory" });
    }
    const p = ctx.svc.createProject({ name: body.name, rootPath: resolve(rootPath) });
    return reply.code(201).send(p);
  });

  app.get("/api/projects/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = ctx.svc.getProject(id);
    if (!p) return reply.code(404).send({ error: "project not found" });
    return p;
  });

  app.get("/api/projects", async () => {
    return ctx.svc.listProjects();
  });
}
