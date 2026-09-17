// Branch routes (docs/10, hard gates 1/3/5/6). The POST /messages handler
// drives the explicit turn lifecycle through the session manager, and POST /
// (from-node) performs the EAGER fork freeze.

import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { runTurnOnce } from "../turn-runner.js";

export function registerBranches(app: FastifyInstance, ctx: AppContext): void {
  const { svc, repo, sessionManager, forkOrchestrator, bus, adapter } = ctx;

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
      const b = svc.createRootConversation({ projectId: body.projectId, rootBranchName: body.displayName ?? "Main" });
      return reply.code(201).send({
        branch: b,
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

  app.get("/api/branches/:id", async (req) => {
    const { id } = req.params as { id: string };
    const b = svc.getBranch(id);
    if (!b) return { error: "branch not found" };
    return b;
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
    if (sessionManager.isBusy(id)) {
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

    // The turn itself is invoked asynchronously; failures are observable via WS
    // + the node going failed/cancelled.
    void runTurnAsync(id, node.id, body.text, body.cwd);
    return reply.code(202).send({ nodeId: node.id });
  });

  async function runTurnAsync(branchId: string, nodeId: string, text: string, cwd?: string): Promise<void> {
    try {
      const st = await sessionManager.resolveSession({
        branchId,
        cwd: cwd ?? svc.getBranch(branchId)?.workspacePath ?? ".",
      });
      // The in-flight node was claimed synchronously in the handler (gate 11)
      // and drained into st.nodeId by resolveSession; release() clears it at end.
      const { result } = await runTurnOnce({
        svc, bus, adapter,
        sessionKey: st.sessionKey,
        branchId,
        nodeId,
        runtimeSessionId: st.sessionKey,
        text,
      });
      if (result.status === "cancelled") {
        svc.cancelTurn(nodeId, { runtimeSessionId: st.sessionKey });
      } else {
        svc.completeTurn(nodeId, {
          assistantContent: result.assistantContent,
          status: result.status === "completed" ? "completed" : "failed",
        });
      }
      sessionManager.release(branchId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      try {
        svc.completeTurn(nodeId, { assistantContent: null, status: "failed" });
      } catch { /* node already terminal */ }
      try { sessionManager.release(branchId); } catch { /* already cleared */ }
      // eslint-disable-next-line no-console
      console.error(`[turn ${branchId}/${nodeId}] ${msg}`);
    }
  }

  // Interrupt ONLY this branch's active invocation (gate 6): 202 accepted;
  // the route leaves the domain transition to the turn's own cancellation path
  // (adapter interrupt surfaces wasInterrupted → runTurnOnce returns cancelled
  // → cancelTurn). 409 idle if nothing is running here.
  app.post("/api/branches/:id/interrupt", async (req, reply) => {
    const { id } = req.params as { id: string };
    const st = sessionManager.getState(id);
    if (!st) return reply.code(409).send({ error: "branch is idle" });
    const key = await sessionManager.interrupt(id);
    const active = key !== null;
    return reply.code(active ? 202 : 409).send(
      active ? { interrupted: key } : { error: "branch is idle" }
    );
  });

  // Breadcrumb (docs/10 §ancestry): this branch + its snapshot + ancestors.
  app.get("/api/branches/:id/ancestry", async (req) => {
    const { id } = req.params as { id: string };
    const a = svc.getBranchAncestry(id);
    if (!a) return { error: "branch not found" };
    return a;
  });
}
