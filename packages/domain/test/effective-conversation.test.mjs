import { test } from "node:test";
import assert from "node:assert/strict";
import { newService } from "./helpers.mjs";

// Phase 4 hard gate 3: effective-conversation read model — the chat as a
// fork actually sees it, with origin metadata and fork-point cut-off.
function buildFork(svc) {
  const p = svc.createProject({ name: "p" });
  const main = svc.createRootConversation({ projectId: p.id, rootBranchName: "Main" });
  const t1 = svc.appendCompletedTurn({ branchId: main.id, userContent: "T1", assistantContent: "a:T1" });
  const t2 = svc.appendCompletedTurn({ branchId: main.id, userContent: "T2", assistantContent: "a:T2" });
  const t3 = svc.appendCompletedTurn({ branchId: main.id, userContent: "T3", assistantContent: "a:T3" });
  const child = svc.createBranchFromNode({ projectId: p.id, forkFromNodeId: t2.id, displayName: "Child" });
  const c1 = svc.appendCompletedTurn({ branchId: child.id, userContent: "C1", assistantContent: "a:C1" });
  return { p, main, t1, t2, t3, child, c1 };
}

test("g3: effective conversation = inherited prefix through fork point + local", () => {
  const { svc, close } = newService();
  const f = buildFork(svc);

  const conv = svc.getEffectiveConversation(f.child.id);
  assert.deepEqual(
    conv.map((m) => `${m.origin}:${m.role}:${m.content}`),
    [
      "inherited:user:T1",
      "inherited:assistant:a:T1",
      "inherited:user:T2",
      "inherited:assistant:a:T2", // fork point inclusive
      "local:user:C1",
      "local:assistant:a:C1",
    ],
  );

  // fork-point cut-off: parent T3 (after the fork) is NOT inherited
  assert.ok(!conv.some((m) => m.content === "T3" || m.content === "a:T3"));
  close();
});

test("g3: root branch has no inherited prefix", () => {
  const { svc, close } = newService();
  const f = buildFork(svc);
  const conv = svc.getEffectiveConversation(f.main.id);
  assert.ok(conv.every((m) => m.origin === "local"));
  assert.equal(conv.length, 6);
  close();
});

test("g3: grandchild inherits both ancestors up to each fork point", () => {
  const { svc, close } = newService();
  const f = buildFork(svc);
  const gc = svc.createBranchFromNode({ projectId: f.p.id, forkFromNodeId: f.c1.id, displayName: "Grandchild" });
  const g1 = svc.appendCompletedTurn({ branchId: gc.id, userContent: "G1", assistantContent: "a:G1" });

  const conv = svc.getEffectiveConversation(gc.id);
  assert.deepEqual(
    conv.map((m) => `${m.origin}:${m.role}:${m.content}`),
    [
      "inherited:user:T1",
      "inherited:assistant:a:T1",
      "inherited:user:T2",
      "inherited:assistant:a:T2",
      "inherited:user:C1",
      "inherited:assistant:a:C1",
      "local:user:G1",
      "local:assistant:a:G1",
    ],
  );
  assert.ok(!conv.some((m) => m.content === "T3" || m.content === "a:T3"));
  close();
});

test("g3: fork point excluded when forking before a branch's last node", () => {
  const { svc, close } = newService();
  const f = buildFork(svc);
  // fork Child from Main:T1 (before T2/T3) → only T1 inherited
  const snap = svc.createBranchFromNode({ projectId: f.p.id, forkFromNodeId: f.t1.id, displayName: "Snap" });
  const conv = svc.getEffectiveConversation(snap.id);
  assert.deepEqual(
    conv.map((m) => m.content),
    ["T1", "a:T1"],
  );
  close();
});
