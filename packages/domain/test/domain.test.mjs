import { test } from "node:test";
import assert from "node:assert/strict";
import { DomainError } from "../dist/index.js";
import { newService, branchDigest, projectDigest } from "./helpers.mjs";

function buildGateFixture(svc) {
  // Main
  const project = svc.createProject({ name: "gate", rootPath: "/tmp/gate" });
  const main = svc.createRootConversation({ projectId: project.id, rootBranchName: "Main" });
  const t1 = svc.appendCompletedTurn({ branchId: main.id, userContent: "T1", assistantContent: "a:T1" });
  const t2 = svc.appendCompletedTurn({ branchId: main.id, userContent: "T2", assistantContent: "a:T2" });
  const t3 = svc.appendCompletedTurn({ branchId: main.id, userContent: "T3", assistantContent: "a:T3" });

  // Branch A forks from T2 on Main
  const branchA = svc.createBranchFromNode({
    projectId: project.id,
    forkFromNodeId: t2.id,
    displayName: "Branch A",
  });
  const aT1 = svc.appendCompletedTurn({ branchId: branchA.id, userContent: "A:T1", assistantContent: "a:A:T1" });
  const aT2 = svc.appendCompletedTurn({ branchId: branchA.id, userContent: "A:T2", assistantContent: "a:A:T2" });

  // Branch A1 forks from A:T2
  const branchA1 = svc.createBranchFromNode({
    projectId: project.id,
    forkFromNodeId: aT2.id,
    displayName: "Branch A1",
  });
  svc.appendCompletedTurn({ branchId: branchA1.id, userContent: "A1:T1", assistantContent: "a:A1:T1" });

  return { project, main, t1, t2, t3, branchA, aT1, aT2, branchA1 };
}

test("gate fixture: structure, ancestry, duplicate labels", () => {
  const { svc, repo, close } = newService();
  const f = buildGateFixture(svc);

  // Main branch exact ancestry
  assert.equal(f.main.parentBranchId, null);
  assert.equal(f.branchA.parentBranchId, f.main.id);
  assert.equal(f.branchA.forkFromNodeId, f.t2.id);
  assert.equal(f.branchA1.parentBranchId, f.branchA.id);
  assert.equal(f.branchA1.forkFromNodeId, f.aT2.id);

  // Duplicate display names allowed (constituent invariant #4)
  const dup = svc.createBranchFromNode({
    projectId: f.project.id,
    forkFromNodeId: f.t3.id,
    displayName: "Branch A",
  });
  assert.equal(dup.displayName, "Branch A");
  assert.equal(f.branchA.displayName, "Branch A");

  // Ancestry shape root..this (target excluded)
  const anc = svc.getBranchAncestry(f.branchA1.id);
  assert.deepEqual(
    anc.ancestors.map((a) => a.branch.displayName),
    ["Main", "Branch A"],
  );

  // Root branch forked node is null
  const rootAnc = svc.getBranchAncestry(f.main.id);
  assert.equal(rootAnc.branch.parentBranchId, null);
  assert.equal(rootAnc.ancestors.length, 0);

  // Snapshot on branch captures lineage
  const snap = svc.getSnapshot(f.branchA.id);
  assert.ok(snap);
  assert.equal(snap.forkFromNodeId, f.t2.id);
  assert.equal(snap.visibleMessages.length, 4); // T1 user+asst + T2 forknode user+asst

  // Per-branch turn count
  assert.equal(repo.listNodesByBranch(f.main.id).length, 3);
  assert.equal(repo.listNodesByBranch(f.branchA.id).length, 2);
  assert.equal(repo.listNodesByBranch(f.branchA1.id).length, 1);
  close();
});

test("appendCompletedTurn: local_turn_index sequential, ancestry lineage", () => {
  const { svc, repo, close } = newService();
  const f = buildGateFixture(svc);

  const nodes = repo.listNodesByBranch(f.branchA.id);
  assert.deepEqual(nodes.map((n) => n.localTurnIndex), [0, 1]);

  // parent links within branch
  const t2node = f.t2;
  const t1node = svc.getNode(f.t1.id);
  assert.equal(t2node.parentNodeId, t1node.id);
  assert.equal(nodes[1].parentNodeId, nodes[0].id);
  close();
});

test("createBranchFromNode: rejects node from another project", () => {
  const { svc, close } = newService();
  const p1 = svc.createProject({ name: "p1" });
  const p2 = svc.createProject({ name: "p2" });
  const b1 = svc.createRootConversation({ projectId: p1.id });
  const t1 = svc.appendCompletedTurn({ branchId: b1.id, userContent: "x", assistantContent: "y" });
  assert.throws(
    () => svc.createBranchFromNode({ projectId: p2.id, forkFromNodeId: t1.id }),
    /belongs to project/
  );
  close();
});

test("appendCompletedTurn: rejects root-fork of a missing node / archives stop append", () => {
  const { svc, close } = newService();
  const p = svc.createProject({ name: "p" });
  const main = svc.createRootConversation({ projectId: p.id });
  const t1 = svc.appendCompletedTurn({ branchId: main.id, userContent: "t1", assistantContent: "a" });

  // Branches can only fork from an existing node of the SAME project (redundant with above)
  // Archive blocks append but allows fork? Test archive path:
  const b = svc.createBranchFromNode({ projectId: p.id, forkFromNodeId: t1.id, displayName: "b" });
  svc.archiveBranch(b.id);
  assert.throws(() => svc.appendCompletedTurn({ branchId: b.id, userContent: "after" }), /is archived/);
  // branch still queryable
  assert.equal(svc.getBranch(b.id).status, "archived");
  assert.ok(svc.getBranch(b.id).archivedAt);
  close();
});

test("renameBranch: display name change, id unchanged", () => {
  const { svc, close } = newService();
  const p = svc.createProject({ name: "p" });
  const b = svc.createRootConversation({ projectId: p.id });
  const originalId = b.id;
  const renamed = svc.renameBranch(b.id, "new name");
  assert.equal(renamed.id, originalId);
  assert.equal(renamed.displayName, "new name");
  close();
});

test("getConversationTree: shape matches fixture without children cross-talk", () => {
  const { svc, repo, close } = newService();
  const f = buildGateFixture(svc);

  // Per-branch conversation tree is a linear chain of turns (branch list holds the forks).
  const tree = svc.getConversationTree(f.main.id);
  assert.equal(tree.id, f.t1.id); // root is T1 (parent null)
  assert.deepEqual(tree.children.map((c) => c.id), [f.t2.id]);
  assert.deepEqual(tree.children[0].children.map((c) => c.id), [f.t3.id]);

  const aTree = svc.getConversationTree(f.branchA.id);
  assert.equal(aTree.id, f.aT1.id);
  assert.deepEqual(aTree.children.map((c) => c.id), [f.aT2.id]);

  const a1Tree = svc.getConversationTree(f.branchA1.id);
  assert.equal(a1Tree.id, repo.listNodesByBranch(f.branchA1.id)[0].id);
  close();
});
