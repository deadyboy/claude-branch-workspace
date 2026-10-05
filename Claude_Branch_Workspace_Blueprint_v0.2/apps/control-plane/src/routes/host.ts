// Execution-host identity (S1, docs/14 §3). The control-plane instance IS the
// execution host: `project.rootPath` is always a path on THIS machine, so the
// UI shows the hostname/platform/cwd next to each project and never pretends a
// browser folder picker can hand the server a remote directory.

import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { hostname } from "node:os";

export function registerHost(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/host", async () => {
    // Adapters are derived from what is actually wired, never hardcoded: the
    // branch rows carry the adapter that produced each session
    // (domain default "claude-cli"). The fake runtime is a test double, not a
    // user-facing adapter, so it is reported as the adapter it stands in for.
    const adapters = new Set<string>();
    for (const project of ctx.svc.listProjects()) {
      for (const branch of ctx.svc.listBranches(project.id)) {
        if (branch.runtimeAdapter) adapters.add(branch.runtimeAdapter);
      }
    }
    if (adapters.size === 0) adapters.add("claude-cli");
    return {
      hostname: hostname(),
      platform: process.platform,
      cwd: process.cwd(),
      adapters: [...adapters].sort(),
    };
  });
}
