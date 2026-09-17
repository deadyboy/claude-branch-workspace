import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newService, projectDigest } from "./helpers.mjs";

function buildGateFixture(svc) {
  const project = svc.createProject({ name: "gate", rootPath: "/tmp/gate" });
  const main = svc.createRootConversation({ projectId: project.id, rootBranchName: "Main" });
  const t1 = svc.appendCompletedTurn({ branchId: main.id, userContent: "T1", assistantContent: "a:T1" });
  const t2 = svc.appendCompletedTurn({ branchId: main.id, userContent: "T2", assistantContent: "a:T2" });
  svc.appendCompletedTurn({ branchId: main.id, userContent: "T3", assistantContent: "a:T3" });

  const branchA = svc.createBranchFromNode({
    projectId: project.id,
    forkFromNodeId: t2.id,
    displayName: "Branch A",
  });
  const aT1 = svc.appendCompletedTurn({ branchId: branchA.id, userContent: "A:T1", assistantContent: "a:A:T1" });
  const aT2 = svc.appendCompletedTurn({ branchId: branchA.id, userContent: "A:T2", assistantContent: "a:A:T2" });

  const branchA1 = svc.createBranchFromNode({
    projectId: project.id,
    forkFromNodeId: aT2.id,
    displayName: "Branch A1",
  });
  svc.appendCompletedTurn({ branchId: branchA1.id, userContent: "A1:T1", assistantContent: "a:A1:T1" });

  return { project, main, branchA, branchA1 };
}

test("restart recovery: tree identical after close + reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "cbw-restart-"));
  const dbPath = join(dir, "data.db");

  // Session 1: write the whole gate fixture
  let ctx = newService(dbPath);
  const f = buildGateFixture(ctx.svc);
  const digestBefore = projectDigest(ctx.repo, f.project.id);
  const ids = {
    project: f.project.id,
    main: f.main.id,
    branchA: f.branchA.id,
    branchA1: f.branchA1.id,
  };
  ctx.close();

  // Simulate restart: brand-new handle on the same file
  ctx = newService(dbPath);
  const digestAfter = projectDigest(ctx.repo, ids.project);
  ctx.close();

  assert.deepEqual(digestAfter, digestBefore, "full project digest must survive restart");

  // Branch ids and fork targets must survive (identity, not just labels)
  assert.ok(digestAfter[ids.branchA1], "Branch A1 present after restart");
  assert.equal(digestAfter[ids.branchA1].parent, ids.branchA);
  assert.equal(digestAfter[ids.branchA].parent, ids.main);
  assert.equal(digestAfter[ids.main].parent, null);
  assert.equal(digestAfter[ids.main].digest.length, 3, "Main has T1,T2,T3");
  assert.equal(digestAfter[ids.branchA].digest.length, 2, "Branch A has A:T1,A:T2");
  assert.equal(digestAfter[ids.branchA1].digest.length, 1, "Branch A1 has A1:T1");

  rmSync(dir, { recursive: true, force: true });
});
