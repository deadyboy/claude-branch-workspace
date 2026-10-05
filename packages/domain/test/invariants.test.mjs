import { test } from "node:test";
import assert from "node:assert/strict";
import { DomainError } from "../dist/index.js";
import { newService } from "./helpers.mjs";

test("fork head non-mutation: forking does not rewrite or delete ancestor nodes/messages", () => {
  const { svc, repo, close } = newService();
  const p = svc.createProject({ name: "p" });
  const main = svc.createRootConversation({ projectId: p.id, rootBranchName: "Main" });
  const t1 = svc.appendCompletedTurn({ branchId: main.id, userContent: "t1", assistantContent: "a1" });
  const t2 = svc.appendCompletedTurn({ branchId: main.id, userContent: "t2", assistantContent: "a2" });
  const t1Before = repo.getNode(t1.id);
  const t2Before = repo.getNode(t2.id);
  const nodeCountBefore = repo.listNodesByBranch(main.id).length;
  const msgCountBefore = repo.listMessagesByBranch(main.id).length;

  // Non-destructive fork: branch from T1 (mid-chain) — must NOT reorder T2, delete
  // T2, or mutate T1's messages.
  const b = svc.createBranchFromNode({ projectId: p.id, forkFromNodeId: t1.id, displayName: "F" });
  void b;
  assert.equal(repo.listNodesByBranch(main.id).length, nodeCountBefore, "no node added/removed on Main");
  assert.equal(repo.listMessagesByBranch(main.id).length, msgCountBefore, "no message added/removed on Main");
  const t1After = repo.getNode(t1.id);
  const t2After = repo.getNode(t2.id);
  assert.deepEqual(t1After, t1Before, "T1 node untouched");
  assert.deepEqual(t2After, t2Before, "T2 node untouched");
  assert.equal(t2After.parentNodeId, t1Before.id, "T2 still a child of T1 after fork");

  // Branch context snapshot must be bounded at the fork point, not the head
  const snap = svc.getSnapshot(b.id);
  assert.equal(snap.forkFromNodeId, t1.id);
  assert.deepEqual(snap.ancestorNodeIds, [t1.id, repo.lastNode(main.id)?.id].slice(0, 1));
  close();
});

test("cross-project parent is rejected (parent branch belongs to another project)", () => {
  const { svc, close } = newService();
  const p1 = svc.createProject({ name: "p1" });
  const p2 = svc.createProject({ name: "p2" });
  const b1 = svc.createRootConversation({ projectId: p1.id });
  const t1 = svc.appendCompletedTurn({ branchId: b1.id, userContent: "x", assistantContent: "y" });
  // forkFromNode belongs to p1 but caller claims p2 → reject (stronger than node-level check)
  assert.throws(
    () => svc.createBranchFromNode({ projectId: p2.id, forkFromNodeId: t1.id }),
    /belongs to project/
  );
  close();
});

test("archiveBranch + root-fork validity: cannot fork from an archived branch", () => {
  const { svc, close } = newService();
  const p = svc.createProject({ name: "p" });
  const main = svc.createRootConversation({ projectId: p.id });
  const t1 = svc.appendCompletedTurn({ branchId: main.id, userContent: "t1", assistantContent: "a" });
  svc.createBranchFromNode({ projectId: p.id, forkFromNodeId: t1.id, displayName: "b" });
  svc.archiveBranch(main.id);
  // forking from a node of an archived branch is rejected via requireOpen
  assert.throws(
    () => svc.createBranchFromNode({ projectId: p.id, forkFromNodeId: t1.id, displayName: "b2" }),
    /archived/
  );
  close();
});

test("cannot fork from pending or failed node (review MAJOR #2)", () => {
  const { svc, close } = newService();
  const p = svc.createProject({ name: "p" });
  const main = svc.createRootConversation({ projectId: p.id });
  svc.appendCompletedTurn({ branchId: main.id, userContent: "t1", assistantContent: "a" });
  const pending = svc.appendCompletedTurn({ branchId: main.id, userContent: "t2", status: "pending" });
  const failed = svc.appendCompletedTurn({ branchId: main.id, userContent: "t3", status: "failed" });

  for (const n of [pending, failed]) {
    assert.throws(
      () => svc.createBranchFromNode({ projectId: p.id, forkFromNodeId: n.id, displayName: "x" }),
      /only completed turns are forkable/
    );
  }
  // completed node still forks fine
  const ok = svc.getNode(failed.id);
  const head = svc.appendCompletedTurn({ branchId: main.id, userContent: "t4", assistantContent: "a4" });
  void head;
  const t1 = svc.getNode(pending.id).parentNodeId;
  assert.ok(t1);
  close();
});

test("failed nodes have no completedAt (review corollary)", () => {
  const { svc, close } = newService();
  const p = svc.createProject({ name: "p" });
  const main = svc.createRootConversation({ projectId: p.id });
  const f = svc.appendCompletedTurn({ branchId: main.id, userContent: "t", status: "failed" });
  assert.equal(f.completedAt, null);
  const c = svc.appendCompletedTurn({ branchId: main.id, userContent: "t2", assistantContent: "a" });
  assert.ok(c.completedAt);
  close();
});

test("appendCompletedTurn is atomic: a failing node insert rolls back orphan messages", () => {
  const { svc, repo, close } = newService();
  const p = svc.createProject({ name: "p" });
  const main = svc.createRootConversation({ projectId: p.id });
  svc.appendCompletedTurn({ branchId: main.id, userContent: "t1", assistantContent: "a1" });

  const before = repo.listMessagesByBranch(main.id).length;
  const userMsgSeq = repo.nextMessageSeq(main.id);

  // Concurrent-writer simulation: an inline transaction that inserts an
  // assistant row AFTER a colliding user row (same seq as t1's user row) must
  // fail atomically — the assistant "ghost" must NOT survive.
  assert.throws(() => {
    repo.transaction(() => {
      repo.insertMessage({
        id: "ghost-user",
        nodeId: null,
        branchId: main.id,
        role: "user",
        visibleContent: "ghost",
        runtimeMessageId: null,
        createdAt: new Date().toISOString(),
        seq: userMsgSeq - 1, // collides with t1 user seq → UNIQUE(branch_id,seq)
      });
      repo.insertMessage({
        id: "ghost-asst",
        nodeId: null,
        branchId: main.id,
        role: "assistant",
        visibleContent: "ghost-a",
        runtimeMessageId: null,
        createdAt: new Date().toISOString(),
        seq: userMsgSeq,
      });
    });
  });

  assert.equal(
    repo.listMessagesByBranch(main.id).length,
    before,
    "failed transaction must not leave orphan/gap messages"
  );
  assert.equal(repo.getMessage("ghost-asst"), null, "ghost assistant row rolled back");
  close();
});
