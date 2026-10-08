import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { FileAccessError, readFileContent } from "../file-content.js";

export function registerFiles(app: FastifyInstance, { svc }: AppContext) {
  for (const kind of ["projects", "branches"] as const) {
    app.get(`/api/${kind}/:id/files/content`, async (req, reply) => {
      const { id } = req.params as { id: string };
      const item = kind === "projects" ? svc.getProject(id) : svc.getBranch(id);
      if (!item) return reply.code(404).send({ error: `${kind === "projects" ? "project" : "branch"} not found` });
      const branch = kind === "branches" ? svc.getBranch(id)! : null;
      const root = branch ? branch.workspacePath ?? (branch.workspaceMode === "shared" ? svc.getProject(branch.projectId)?.rootPath : null) : svc.getProject(id)?.rootPath;
      if (!root) return reply.code(409).send({ error: "workspace path is unavailable" });
      const path = (req.query as { path?: unknown }).path;
      if (typeof path !== "string") return reply.code(400).send({ error: "path is required" });
      try { return await readFileContent(root, path); }
      catch (err) { if (err instanceof FileAccessError) return reply.code(err.code).send({ error: err.message }); throw err; }
    });
  }
}
