// Control-plane entrypoint (S5). Boots the DB, wires the real (or fake)
// runtime, reconciles any crash leftovers (gate 15), builds the Fastify app
// and listens on 127.0.0.1:15723 ONLY (gate 12 — loopback bound).
//
// CBW_FAKE_RUNTIME=1  → FakeRuntime adapter (hermetic E2E, gate 10)
// CBW_DB=<path>       → overrides the default SQLite file

import { openDb, Repository, DomainService } from "@cbw/domain";
import { EventBus } from "@cbw/event-protocol";
import { ClaudeCliAdapter, type RuntimeAdapter } from "@cbw/runtime";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { SessionManager } from "./session-manager.js";
import { ForkOrchestrator } from "./fork-orchestrator.js";
import { AttentionRegistry } from "./attention-registry.js";
import { reconcileOnBoot } from "./reconcile.js";
import { buildApp, defaultStaticDir } from "./server.js";
import { FakeRuntime, type FakeScript } from "./fake-runtime.js";
import type { AppContext } from "./context.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { TurnScheduler } from "./turn-scheduler.js";
import { claimDatabase } from "./database-owner.js";

const HOST = "127.0.0.1"; // hard gate 12: loopback only
const PORT = Number(process.env.CBW_PORT ?? 15723);

function loadFakeAdapter(): FakeRuntime {
  let script: FakeScript | null = null;
  const scriptPath = process.env.CBW_FAKE_SCRIPT;
  if (scriptPath && existsSync(scriptPath)) {
    try {
      script = JSON.parse(readFileSync(scriptPath, "utf8")) as FakeScript;
    } catch {
      // fall back to unscripted defaults
    }
  }
  return new FakeRuntime(script);
}

export async function main(): Promise<void> {
  const dbPath = resolve(process.env.CBW_DB ?? "./data/cbw.db");
  mkdirSync(dirname(dbPath), { recursive: true });
  const ownership = await claimDatabase(dbPath);
  const db = openDb(dbPath);
  const repo = new Repository(db);
  const svc = new DomainService(repo);
  const bus = new EventBus();

  const fake = process.env.CBW_FAKE_RUNTIME === "1";
  // Real runtime adapter with the domain DB as its persistence hook (duck-typed
  // RuntimePersistence): upsertRuntimeSession + getRuntimeSessionByExternalId
  // let it recover the external-id → sessionKey mapping after a control-plane
  // restart (gate 13 restart-resume) instead of dropping to an orphan turn.
  const mcpEntry = fileURLToPath(new URL("../../mcp-server/dist/index.js", import.meta.url));
  const adapter: RuntimeAdapter = fake ? loadFakeAdapter() : new ClaudeCliAdapter(undefined, undefined, svc, undefined, undefined, (sessionKey) => {
    const binding = svc.getRuntimeSession(sessionKey);
    const branch = binding ? svc.getBranch(binding.branchId) : null;
    if (!branch) return null;
    if (!existsSync(mcpEntry)) throw new Error("product MCP server is not built; build @cbw/mcp-server before execution");
    return {
      mcpConfig: JSON.stringify({ mcpServers: { "cbw-control": { command: process.execPath, args: [mcpEntry], env: { CBW_CONTROL_PLANE_URL: `http://${HOST}:${PORT}` } } } }),
      systemContext: `This is a product-managed conversation. Current projectId=${branch.projectId}, branchId=${branch.id}, nodeId=${sessionManager.getState(branch.id)?.nodeId ?? "unavailable"}. CBW MCP tools create persistent branches from completed turns and track delegated work with create_task, run_task, get_task. Use register_artifact with your current nodeId and relative file path to declare existing output files (this verifies existence, not exclusive authorship). Use task execution for delegated work; keep temporary native subagents distinct. Do not submit a task to this busy main branch.`,
    };
  });
  const sessionManager = new SessionManager(svc, adapter);
  const workspaceManager = new WorkspaceManager(svc);
  const scheduler = new TurnScheduler(Number(process.env.CBW_MAX_CONCURRENT ?? 5), Number(process.env.CBW_PER_PROJECT ?? 5));
  const forkOrchestrator = new ForkOrchestrator(svc, sessionManager, adapter, workspaceManager, scheduler);
  const attention = new AttentionRegistry();

  // Interrupt isolation (gate 6): the turn runner + interrupt route already
  // target one branch; nothing to fork here.

  // Restart reconciliation (gate 15 + B3): anything left mid-flight by a crash
  // is cancelled so the UI never shows a permanently-busy card.
  const report = await reconcileOnBoot(svc);
  if (report.cancelledNodes || report.interruptedSessions || report.cancelledOrphanRuns) {
    // eslint-disable-next-line no-console
    console.log(
      `[reconcile] ${report.cancelledNodes} pending node(s), ${report.interruptedSessions} session(s), ${report.cancelledOrphanRuns} orphan run(s)`
    );
  }

  // Attention loop (gate 7): the registry is seeded by streamed canonical
  // events. One bus subscription covers every runner — the TurnObserver stamps
  // projectId/branchId before publish — so permission.requested /
  // attention.required events become pending cards for the UI to answer.
  attention.subscribeToBus(bus);

  const ctx: AppContext = { db, svc, repo, bus, sessionManager, forkOrchestrator, attention, adapter, workspaceManager, scheduler, fakeAdapter: fake ? adapter : undefined };

  const app = await buildApp({
    ctx,
    staticDir: process.env.CBW_NO_STATIC === "1" ? null : defaultStaticDir(import.meta.url),
    logger: process.env.CBW_LOG === "1",
  });

  try {
    const addr = await app.listen({ host: HOST, port: PORT });
    // eslint-disable-next-line no-console
    console.log(`[cbw] control plane ${fake ? "(FAKE runtime) " : ""}listening on ${addr}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[cbw] failed to listen:", err);
    db.close();
    process.exit(1);
  }

  const shutdown = async (sig: string): Promise<void> => {
    // eslint-disable-next-line no-console
    console.log(`[cbw] ${sig} — shutting down`);
    try {
      await app.close();
      db.close();
      ownership.close();
      process.exit(0);
    } catch {
      console.error("[cbw] shutdown did not drain active work");
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

// Direct execution only (imported by tests for buildApp; main() not run).
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"));
if (isMain) {
  void main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[cbw] fatal:", err);
    process.exit(1);
  });
}

export { buildApp, reconcileOnBoot };
export * from "./branch-runner.js";
export type { AppContext };
