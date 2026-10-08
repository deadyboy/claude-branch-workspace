// Project routes (docs/10): create + read projects. S1 adds the capability
// probe (docs/14 §4.1) and PATCH for name/rootPath edits.

import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { resolve, isAbsolute } from "node:path";
import { stat } from "node:fs/promises";
import { probeProjectCapabilities } from "../project-capabilities.js";
import { buildProjectGraph } from "../project-graph.js";

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

  // S1 capability probe (docs/14 §4.1): whether a worktree branch can be
  // created for this project right now — and if not, why (human-readable).
  app.get("/api/projects/:id/capabilities", async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = ctx.svc.getProject(id);
    if (!p) return reply.code(404).send({ error: "project not found" });
    return probeProjectCapabilities(p);
  });

  // S5 project relationship graph (docs/14 §4.4, E8). `depth` controls how many
  // directory layers are expanded; the builder clamps it and reports `truncated`
  // when a limit is hit. Paths, types and sizes only — never file contents.
  app.get("/api/projects/:id/graph", async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = ctx.svc.getProject(id);
    if (!p) return reply.code(404).send({ error: "project not found" });

    const raw = (req.query as { depth?: string } | undefined)?.depth;
    if (raw !== undefined && raw !== "" && !/^\d+$/.test(raw)) {
      return reply.code(400).send({ error: "depth must be a non-negative integer" });
    }
    const depth = raw === undefined || raw === "" ? undefined : Number(raw);
    return buildProjectGraph(ctx.svc, id, { depth });
  });

  // S1 edit (docs/14 §4.1): rename and/or repoint rootPath. Same validation as
  // POST /api/projects (absolute + existing directory); identity (id/createdAt)
  // is preserved — branches and conversations keep referencing this project.
  app.patch("/api/projects/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = ctx.svc.getProject(id);
    if (!p) return reply.code(404).send({ error: "project not found" });

    const body = (req.body ?? {}) as { name?: unknown; rootPath?: unknown };
    if (body.name === undefined && body.rootPath === undefined) {
      return reply.code(400).send({ error: "name or rootPath is required" });
    }
    if (body.name !== undefined && (typeof body.name !== "string" || !body.name)) {
      return reply.code(400).send({ error: "name must be a non-empty string" });
    }
    if (body.rootPath !== undefined) {
      const rootPath = body.rootPath;
      if (typeof rootPath !== "string" || !isAbsolute(rootPath) || !(await stat(rootPath).catch(() => null))?.isDirectory()) {
        return reply.code(400).send({ error: "rootPath must be an existing absolute directory" });
      }
    }
    return ctx.svc.updateProject(id, {
      name: body.name as string | undefined,
      rootPath: body.rootPath === undefined ? undefined : resolve(body.rootPath as string),
    });
  });
}
