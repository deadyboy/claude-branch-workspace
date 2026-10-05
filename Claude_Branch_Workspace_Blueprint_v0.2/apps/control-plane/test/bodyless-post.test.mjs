// Regression: bodyless POSTs must not be forced to declare a JSON body.
//
// Found by driving the real UI: the web client's shared request helper set
// `content-type: application/json` unconditionally, while Interrupt and Archive
// send NO body. Fastify treats that combination as a malformed request and the
// generic error handler surfaces it as a 500 — so clicking Interrupt or Archive
// in the UI failed with a spurious server error.
//
// These tests pin the SERVER side of the contract: a bodyless POST must reach
// the route handler and produce its real status (404/409), never a parse 500.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setupService, fakeAdapter } from "./helpers.mjs";
import { SessionManager } from "../dist/session-manager.js";
import { ForkOrchestrator } from "../dist/fork-orchestrator.js";
import { AttentionRegistry } from "../dist/attention-registry.js";
import { WorkspaceManager } from "../dist/workspace-manager.js";
import { TurnScheduler } from "../dist/turn-scheduler.js";
import { buildApp } from "../dist/server.js";

async function makeApp() {
  const { svc, repo, bus } = setupService();
  const adapter = fakeAdapter();
  const sessionManager = new SessionManager(svc, adapter);
  const app = await buildApp({
    ctx: {
      db: null, svc, repo, bus, sessionManager,
      forkOrchestrator: new ForkOrchestrator(svc, adapter, sessionManager, bus),
      attention: new AttentionRegistry(),
      adapter,
      workspaceManager: new WorkspaceManager(svc),
      scheduler: new TurnScheduler(5, 5, 10),
    },
    logger: false,
  });
  await app.ready();
  return { app, svc };
}

test("bodyless POST reaches the handler (no content-type) — archive 404", async () => {
  const { app } = await makeApp();
  const res = await app.inject({ method: "POST", url: "/api/branches/nope/archive" });
  assert.equal(res.statusCode, 404, "must be a real 404, not a parse 500");
  await app.close();
});

test("bodyless POST with an EMPTY json body is still accepted", async () => {
  // The client may legitimately send `{}` or nothing; neither may 500.
  const { app } = await makeApp();
  const empty = await app.inject({
    method: "POST",
    url: "/api/branches/nope/interrupt",
  });
  assert.notEqual(empty.statusCode, 500, "empty body must not be a 500");
  assert.equal(empty.statusCode, 409, "idle/unknown branch -> the route's real answer");
  await app.close();
});

test("interrupt on a real branch gives a real answer, not a 500", async () => {
  const { app, svc } = await makeApp();
  const p = svc.createProject({ name: "bodyless" });
  const b = svc.createRootConversation({ projectId: p.id, rootBranchName: "Main" });
  const res = await app.inject({ method: "POST", url: `/api/branches/${b.id}/interrupt` });
  // Idle branch -> 409. The point is it is a REAL status, never a parse 500.
  assert.equal(res.statusCode, 409);
  assert.notEqual(res.statusCode, 500);
  await app.close();
});
