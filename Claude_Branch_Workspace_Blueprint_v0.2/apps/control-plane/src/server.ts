// buildApp: Fastify factory (S5). Injectable, no listen side-effect — hermetic
// tests build an app over an in-memory DB and hit it with inject()/injectWS().
//
// Registration order (reviewer R3): cors (dev allowlist) -> websocket -> ROUTES
// -> static LAST so the SPA wildcard can never shadow /api/* or /ws/*.
// Loopback is enforced at listen() time (gate 12), not here, so tests may
// listen on ephemeral ports; index.ts always calls listen({host:"127.0.0.1"}).

import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import staticServe from "@fastify/static";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { AppContext } from "./context.js";
import { DomainError } from "@cbw/domain";
import { CapacityUnavailable } from "./turn-scheduler.js";
import { registerProjects } from "./routes/projects.js";
import { registerHost } from "./routes/host.js";
import { registerBranches } from "./routes/branches.js";
import { registerConversation } from "./routes/conversation.js";
import { registerNodes } from "./routes/nodes.js";
import { registerEvents } from "./routes/events.js";
import { registerAgentRuns } from "./routes/agent-runs.js";
import { registerRuntime } from "./routes/runtime.js";
import { registerAttention } from "./routes/attention.js";
import { registerWs } from "./ws.js";

export interface BuildAppOptions {
  ctx: AppContext;
  corsAllowlist?: string[];
  staticDir?: string | null;
  websocket?: boolean;
  logger?: boolean;
}

export const DEV_ALLOWLIST_HOSTS = ["http://localhost:5173", "http://127.0.0.1:5173"];
const DEFAULT_ALLOWLIST = DEV_ALLOWLIST_HOSTS;

export async function buildApp(opts: BuildAppOptions): Promise<import("fastify").FastifyInstance> {
  const { ctx, corsAllowlist = DEFAULT_ALLOWLIST, staticDir = null, logger = false } = opts;
  const app = Fastify({ logger });

  // CORS controls response access, not whether a malicious page can POST.
  app.addHook("onRequest", async (req, reply) => {
    const host = req.headers.host ?? "";
    let hostname = "";
    try { hostname = new URL(`http://${host}`).hostname; } catch { /* reject below */ }
    if (!["127.0.0.1", "localhost", "[::1]"].includes(hostname)) {
      return reply.code(403).send({ error: "loopback host required" });
    }
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}` && origin !== `https://${host}` && !corsAllowlist.includes(origin)) {
      return reply.code(403).send({ error: "forbidden origin" });
    }
  });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof CapacityUnavailable) return reply.code(409).send({ error: err.message });
    if (err instanceof DomainError) {
      const code = /not found/.test(err.message) ? 404 : /archived|pending|completed|binding/.test(err.message) ? 409 : 400;
      return reply.code(code).send({ error: err.message });
    }
    return reply.code(500).send({ error: "operation failed; inspect runtime status" });
  });

  // preClose runs before Fastify waits for in-flight synchronous fork RPCs.
  // onClose would wait for those same RPCs before it could interrupt them.
  app.addHook("preClose", async () => {
    if (!ctx.scheduler) return;
    ctx.scheduler.close();
    const ids = ctx.scheduler.snapshot().running;
    await Promise.allSettled(ids.map(id => ctx.sessionManager.interrupt(id)));
    if (!await ctx.scheduler.drain(15_000)) throw new Error("active turns did not stop; database remains open");
  });

  // Cors: dev-only explicit allowlist (gate 12). Production is same-origin
  // (Fastify serves the SPA), so no permissive CORS is registered.
  await app.register(cors, {
    origin: corsAllowlist,
    methods: ["GET", "POST", "PATCH"],
  });

  await app.register(websocket);

  // ROUTES FIRST.
  registerProjects(app, ctx);
  registerHost(app, ctx);
  registerBranches(app, ctx);
  registerConversation(app, ctx);
  registerNodes(app, ctx);
  registerEvents(app, ctx);
  registerAgentRuns(app, ctx);
  registerRuntime(app, ctx);
  registerAttention(app, ctx);
  registerWs(app, ctx);

  // Static (SPA) LAST — the wildcard fallback must never shadow /api/* or /ws/*.
  if (staticDir) {
    const dir = resolve(staticDir);
    if (existsSync(dir)) {
      await app.register(staticServe, {
        root: dir,
        prefix: "/",
        index: ["index.html"],
      });
      // SPA fallback: non-/api, non-/ws GET → index.html.
      app.setNotFoundHandler((req, reply) => {
        if (req.raw.method !== "GET") return reply.code(405).send({ error: "method not allowed" });
        if (/^\/(api|ws)\//.test(req.url)) return reply.code(404).send({ error: "not found" });
        return reply.sendFile("index.html");
      });
    }
  }

  return app;
}

/** Default SPA dist dir relative to this source file. */
export function defaultStaticDir(importMetaUrl: string): string {
  return resolve(dirname(fileURLToPath(importMetaUrl)), "../../web/dist");
}
