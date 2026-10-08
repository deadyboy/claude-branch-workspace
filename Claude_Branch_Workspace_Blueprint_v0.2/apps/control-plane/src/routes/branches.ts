// Branch routes (docs/10, hard gates 1/3/5/6). The POST /messages handler
// drives the explicit turn lifecycle through the session manager, and POST /
// (from-node) performs the EAGER fork freeze.

import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { FileAccessError, resolveSafeFile } from "../file-content.js";
import { turnExecution } from "../turn-execution.js";

export function registerBranches(app: FastifyInstance, ctx: AppContext): void {
  const { svc, repo, sessionManager, forkOrchestrator, bus, adapter } = ctx;
  const workspaceManager = ctx.workspaceManager;
  const scheduler = ctx.scheduler;
  const { submitTurn } = turnExecution(ctx);

  app.get("/api/projects/:id/branches", async (req) => {
    const { id } = req.params as { id: string };
    return repo.listBranchesByProject(id);
  });

  // Root creation OR from-node fork (frozen at creation, gate 1).
  app.post("/api/branches", async (req, reply) => {
    const body = (req.body ?? {}) as {
      projectId?: string;
      displayName?: string | null;
      forkFromNodeId?: string | null;
      cwd?: string | null;
      workspaceMode?: "shared" | "worktree";
    };
    if (!body.projectId) return reply.code(400).send({ error: "projectId is required" });
    if (!body.forkFromNodeId) {
      if (body.workspaceMode === "worktree") {
        return reply.code(400).send({ error: "root conversations cannot use worktree mode" });
      }
      const b = svc.createRootConversation({ projectId: body.projectId, rootBranchName: body.displayName ?? "Main" });
      if (workspaceManager) await workspaceManager.bind(b, body.cwd ?? null);
      return reply.code(201).send({
        branch: svc.getBranch(b.id) ?? b,
        snapshot: null,
        sessionKey: null,
        strategy: "lazy_root",
      });
    }
    const created = await forkOrchestrator.createFork({
      projectId: body.projectId,
      forkFromNodeId: body.forkFromNodeId,
      displayName: body.displayName ?? null,
      cwd: body.cwd ?? null,
      workspaceMode: body.workspaceMode ?? "shared",
    });
    return reply.code(201).send(created);
  });

  app.get("/api/branches/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = svc.getBranch(id);
    if (!b) return reply.code(404).send({ error: "branch not found" });
    return {
      ...b,
      busy: sessionManager.hasActiveTurn(id),
      queued: scheduler?.snapshot().queued.includes(id) ?? false,
    };
  });

  app.patch("/api/branches/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { displayName?: string };
    if (!body.displayName || typeof body.displayName !== "string") {
      return reply.code(400).send({ error: "displayName is required" });
    }
    const b = svc.getBranch(id);
    if (!b) return reply.code(404).send({ error: "branch not found" });
    return svc.renameBranch(id, body.displayName);
  });

  app.post("/api/branches/:id/archive", async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = svc.getBranch(id);
    if (!b) return reply.code(404).send({ error: "branch not found" });
    if (sessionManager.hasActiveTurn(id)) {
      return reply.code(409).send({ error: "branch is busy; interrupt before archiving" });
    }
    return svc.archiveBranch(id);
  });

  /**
   * Send a user message = begin one turn (gate 5). openTurn persists the user
   * message + a pending node atomically and 202s {nodeId} IMMEDIATELY; the
   * runtime runs asynchronously, streaming events via WS; the node is completed
   * by the terminal event's persist hook (or via POST .../interrupt → cancel).
   * 409 Busy while this branch's prior invocation is still live (gate 11:
   * per-branch serialization, NOT a global lock).
   */
  app.post("/api/branches/:id/messages", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { text?: string; cwd?: string };
    const b = svc.getBranch(id);
    if (!b) return reply.code(404).send({ error: "branch not found" });
    if (!body.text || typeof body.text !== "string") {
      return reply.code(400).send({ error: "text is required" });
    }

    // Per-branch serialization (gate 11): a branch already running one turn must
    // not open a second one (violates the "not a global lock" guarantee). The
    // archive route already 409s; the message route must too. "Busy" here means
    // a turn node is in flight — NOT merely that the branch has a bound session
    // (an eagerly-adopted fork child is idle until its first message).
    if (sessionManager.hasActiveTurn(id)) {
      return reply.code(409).send({ error: "branch is busy; a turn is already running" });
    }

    const node = svc.openTurn({ branchId: id, userContent: body.text });
    // Claim the serialization slot SYNCHRONOUSLY (openTurn is sync; no await
    // between the 409 check, openTurn, and this claim), so a truly-concurrent
    // second POST on a fresh branch sees the node in flight and 409s instead of
    // double-opening during the real-CLI startSession spawn.
    sessionManager.claimTurn(id, node.id);

    // The turn itself is scheduled asynchronously; failures are observable via
    // WS + the node going failed/cancelled. Keep the synchronous claim until a
    // queued cancellation or the runner's terminal path releases it.
    void submitTurn(id, node.id, body.text, body.cwd);
    return reply.code(202).send({ nodeId: node.id });
  });

  // Interrupt ONLY this branch's active invocation (gate 6): 202 accepted;
  // the route leaves the domain transition to the turn's own cancellation path
  // (adapter interrupt surfaces wasInterrupted → runTurnOnce returns cancelled
  // → cancelTurn). 409 idle if nothing is running here.
  app.post("/api/branches/:id/interrupt", async (req, reply) => {
    const { id } = req.params as { id: string };
    const st = sessionManager.getState(id);
    const pending = sessionManager.hasPendingClaim(id);
    const pendingFork = sessionManager.hasPendingFork(id);
    // A bound/adopted idle session is not an invocation. A pending claim is a
    // real turn even before its runtime session has materialized. An eager fork
    // bootstrap is likewise active until its child session is adopted or fails.
    if (st?.nodeId == null && !pending && !pendingFork) return reply.code(409).send({ error: "branch is idle" });
    const active = st?.nodeId != null;
    const queued = scheduler?.cancelQueued(id) ?? false;
    const key = await sessionManager.interrupt(id);
    if (active && key !== null) return reply.code(202).send({ interrupted: key });
    if (pending || pendingFork || queued) return reply.code(202).send({ interruptRequested: true, queued });
    return reply.code(409).send({ error: "branch is idle" });
  });

  // A declared execution result, verified on disk; no exclusive authorship claim.
  app.post("/api/branches/:id/artifacts", async (req, reply) => {
    const { id } = req.params as { id: string };
    const branch = svc.getBranch(id);
    if (!branch) return reply.code(404).send({ error: "branch not found" });
    const body = (req.body ?? {}) as { nodeId?: unknown; path?: unknown; kind?: unknown; summary?: unknown };
    if (typeof body.nodeId !== "string" || typeof body.path !== "string") return reply.code(400).send({ error: "nodeId and relative path are required" });
    const node = svc.getNode(body.nodeId);
    if (!node || node.branchId !== id) return reply.code(400).send({ error: "artifact node must belong to this branch" });
    if (body.kind !== undefined && body.kind !== "file" && body.kind !== "report") return reply.code(400).send({ error: "kind must be file or report" });
    if (body.summary !== undefined && typeof body.summary !== "string") return reply.code(400).send({ error: "summary must be a string" });
    const root = branch.workspacePath ?? (branch.workspaceMode === "shared" ? svc.getProject(branch.projectId)?.rootPath : null);
    if (!root) return reply.code(409).send({ error: "workspace path is unavailable" });
    try {
      const file = await resolveSafeFile(root, body.path);
      if (!file.exists) return reply.code(404).send({ error: "declared artifact file does not exist" });
      const task = svc.listTasksByProject(branch.projectId).find(t => svc.listTaskAttempts(t.id).some(a => a.nodeId === node.id && a.branchId === id));
      const artifact = svc.createArtifact({ projectId: branch.projectId, originBranchId: id, originNodeId: node.id,
        originTaskId: task?.id ?? null, kind: body.kind as "file" | "report" | undefined ?? "file", path: file.path,
        summary: body.summary as string | undefined ?? `Declared result: ${file.path}` });
      return reply.code(201).send(artifact);
    } catch (err) { if (err instanceof FileAccessError) return reply.code(err.code).send({ error: err.message }); throw err; }
  });

  // Breadcrumb (docs/10 §ancestry): this branch + its snapshot + ancestors.
  app.get("/api/branches/:id/ancestry", async (req) => {
    const { id } = req.params as { id: string };
    const a = svc.getBranchAncestry(id);
    if (!a) return { error: "branch not found" };
    return a;
  });
}
