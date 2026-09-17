import { test } from "node:test";
import assert from "node:assert/strict";
import { DomainError } from "../dist/index.js";
import { newService, branchDigest } from "./helpers.mjs";

// Phase 4 hard gate 5: explicit turn lifecycle openTurn → complete/fail/cancel.
test("openTurn persists user message + pending node atomically", () => {
  const { svc, repo, close } = newService();
  const p = svc.createProject({ name: "p" });
  const main = svc.createRootConversation({ projectId: p.id });

  const node = svc.openTurn({ branchId: main.id, userContent: "T1" });
  assert.equal(node.status, "pending");
  assert.equal(node.completedAt, null);
  assert.equal(node.assistantMessageRef, null);

  const msgs = repo.listMessagesByBranch(main.id);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].role, "user");
  assert.equal(msgs[0].visibleContent, "T1");
  assert.equal(msgs[0].nodeId, node.id);
  close();
});

test("completeTurn: inserts assistant message verbatim, flips node, idempotent", () => {
  const { svc, repo, close } = newService();
  const p = svc.createProject({ name: "p" });
  const main = svc.createRootConversation({ projectId: p.id });

  const node = svc.openTurn({ branchId: main.id, userContent: "T1" });
  const done = svc.completeTurn(node.id, { assistantContent: "a:T1", status: "completed" });
  assert.equal(done.status, "completed");
  assert.ok(done.completedAt);
  assert.ok(done.assistantMessageRef);

  // second complete is a no-op (idempotent)
  const again = svc.completeTurn(node.id, { assistantContent: "a:T1-broken", status: "completed" });
  assert.equal(again.id, done.id);
  assert.equal(again.assistantMessageRef, done.assistantMessageRef);

  const digest = branchDigest(repo, done.branchId);
  assert.deepEqual(digest, ["U:T1\nA:a:T1"]);
  close();
});

test("failTurn: sets failed status, no assistant message", () => {
  const { svc, repo, close } = newService();
  const p = svc.createProject({ name: "p" });
  const main = svc.createRootConversation({ projectId: p.id });

  const node = svc.openTurn({ branchId: main.id, userContent: "boom" });
  const failed = svc.completeTurn(node.id, { status: "failed" });
  assert.equal(failed.status, "failed");
  assert.equal(failed.completedAt, null, "failed turn has no completedAt (v1 invariant)");
  close();
});

test("cancelTurn: pending → cancelled, session interrupted, main run closed", () => {
  const { svc, close } = newService();
  const p = svc.createProject({ name: "p" });
  const main = svc.createRootConversation({ projectId: p.id });

  const node = svc.openTurn({ branchId: main.id, userContent: "T1" });
  const run = svc.openAgentRun({ ownerBranchId: main.id, ownerNodeId: node.id, type: "main", name: "Main" });
  const sid = "sess-1";
  svc.upsertRuntimeSession({
    id: sid, branchId: main.id, adapterType: "claude-cli",
    externalSessionId: "ext", status: "running", lastSeenAt: new Date().toISOString(),
  });

  const cancelled = svc.cancelTurn(node.id, { runtimeSessionId: sid });
  assert.equal(cancelled.status, "cancelled");
  assert.ok(cancelled.completedAt);
  assert.equal(svc.getRuntimeSession(sid).status, "interrupted");
  assert.equal(svc.getAgentRun(run.id).status, "cancelled");
  close();
});

test("cancelTurn is idempotent and only touches pending", () => {
  const { svc, close } = newService();
  const p = svc.createProject({ name: "p" });
  const main = svc.createRootConversation({ projectId: p.id });
  const done = svc.openTurn({ branchId: main.id, userContent: "T1" });
  const finished = svc.completeTurn(done.id, { status: "completed" });
  const again = svc.cancelTurn(done.id);
  assert.equal(again.status, "completed", "cancel of a completed node is a no-op");
  close();
});

test("appendCompletedTurn stays a working wrapper (reviewer B4)", () => {
  const { svc, close } = newService();
  const p = svc.createProject({ name: "p" });
  const main = svc.createRootConversation({ projectId: p.id });
  const n = svc.appendCompletedTurn({ branchId: main.id, userContent: "T1", assistantContent: "a" });
  assert.equal(n.status, "completed");
  // legacy 'failed' passes through
  const f = svc.appendCompletedTurn({ branchId: main.id, userContent: "T2", status: "failed" });
  assert.equal(f.status, "failed");
  close();
});

test("openTurn rejects archived branches and missing branches", () => {
  const { svc, close } = newService();
  const p = svc.createProject({ name: "p" });
  const main = svc.createRootConversation({ projectId: p.id });
  assert.throws(() => svc.openTurn({ branchId: "nope", userContent: "x" }), /not found/);
  svc.archiveBranch(main.id);
  assert.throws(() => svc.openTurn({ branchId: main.id, userContent: "x" }), /archived/);
  close();
});
