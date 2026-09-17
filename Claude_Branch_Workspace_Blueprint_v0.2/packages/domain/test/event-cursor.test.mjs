import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { newService } from "./helpers.mjs";

function rec(svc, projectId, branchId, type, seq = 1) {
  return svc.recordEvent({
    projectId,
    branchId,
    type,
    occurredAt: new Date().toISOString(),
    payloadJsonRedacted: "{}",
    sequence: seq,
  });
}

// Phase 4 hard gate 8: durable project-scoped event cursor (seq_rel).
test("g8: seq_rel is project-scoped monotonic across branches", () => {
  const { svc, close } = newService();
  const p = svc.createProject({ name: "p" });
  const main = svc.createRootConversation({ projectId: p.id });
  const child = svc.createBranchFromNode({ projectId: p.id, forkFromNodeId: svc.appendCompletedTurn({ branchId: main.id, userContent: "x" }).id });

  const e1 = rec(svc, p.id, main.id, "session.started");
  const e2 = rec(svc, p.id, child.id, "tool.started");
  const e3 = rec(svc, p.id, main.id, "session.stopped");

  assert.ok(e1.seqRel < e2.seqRel);
  assert.ok(e2.seqRel < e3.seqRel);
  assert.equal(svc.lastEventSeqRel(p.id), e3.seqRel);
  close();
});

test("g8: listEventsSince returns events strictly after cursor, oldest first", () => {
  const { svc, close } = newService();
  const p = svc.createProject({ name: "p" });
  const main = svc.createRootConversation({ projectId: p.id });
  const e1 = rec(svc, p.id, main.id, "a");
  const e2 = rec(svc, p.id, main.id, "b");
  const e3 = rec(svc, p.id, main.id, "c");

  const after = svc.listEventsSince(p.id, e1.seqRel, 100);
  assert.deepEqual(after.map((e) => e.type), ["b", "c"]);
  assert.deepEqual(after.map((e) => e.seqRel), [e2.seqRel, e3.seqRel]);
  close();
});

test("g8: gap-fill from a stale cursor catches up all missed events", () => {
  const { svc, close } = newService();
  const p = svc.createProject({ name: "p" });
  const main = svc.createRootConversation({ projectId: p.id });
  const e1 = rec(svc, p.id, main.id, "start");
  const e2 = rec(svc, p.id, main.id, "mid"); // missed while "offline"
  const e3 = rec(svc, p.id, main.id, "end");

  const gap = svc.listEventsSince(p.id, e1.seqRel, 100);
  assert.deepEqual(gap.map((e) => e.type), ["mid", "end"]);

  // limit respected
  const limited = svc.listEventsSince(p.id, e1.seqRel, 1);
  assert.deepEqual(limited.map((e) => e.type), ["mid"]);
  close();
});

test("g8: cursor survives restart from a file DB", () => {
  const tmp = path.join(os.tmpdir(), `cbw-cursor-${process.pid}-${Date.now()}.db`);
  try {
    let { svc, close } = newService(tmp);
    const p = svc.createProject({ name: "p" });
    const main = svc.createRootConversation({ projectId: p.id });
    const e1 = rec(svc, p.id, main.id, "a");
    const e2 = rec(svc, p.id, main.id, "b");
    close();

    ({ svc, close } = newService(tmp));
    assert.equal(svc.lastEventSeqRel(p.id), e2.seqRel);
    assert.deepEqual(svc.listEventsSince(p.id, e1.seqRel, 100).map((e) => e.type), ["b"]);
    close();
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch {}
  }
});

// Phase 4 hard gate 15 (domain part): reconcile cancels pending nodes +
// orphan sessions + orphan agent runs on boot.
test("g15: reconcileTurnRuns cancels pending nodes, interrupts sessions, cancels agent runs", () => {
  const { svc, close } = newService();
  const p = svc.createProject({ name: "p" });
  const main = svc.createRootConversation({ projectId: p.id });
  const branch = svc.createBranchFromNode({
    projectId: p.id,
    forkFromNodeId: svc.appendCompletedTurn({ branchId: main.id, userContent: "x" }).id,
  });

  // simulate crash mid-turn: pending node + running session + running main run + queued subagent
  const node = svc.openTurn({ branchId: branch.id, userContent: "mid-turn" });
  const mainRun = svc.openAgentRun({ ownerBranchId: branch.id, ownerNodeId: node.id, type: "main", name: "Main" });
  const sub = svc.openAgentRun({ ownerBranchId: branch.id, ownerNodeId: node.id, type: "subagent", name: "Explore" });
  const sid = "crash-session";
  svc.upsertRuntimeSession({
    id: sid, branchId: branch.id, adapterType: "claude-cli",
    externalSessionId: "ext-crash", status: "running", lastSeenAt: new Date().toISOString(),
  });

  const { cancelledNodes, interruptedSessions } = svc.reconcileTurnRuns();
  assert.equal(cancelledNodes, 1);
  assert.equal(interruptedSessions, 1);
  assert.equal(svc.getNode(node.id).status, "cancelled");
  assert.ok(svc.getNode(node.id).completedAt);
  assert.equal(svc.getRuntimeSession(sid).status, "interrupted");
  assert.equal(svc.getAgentRun(mainRun.id).status, "cancelled");
  assert.equal(svc.getAgentRun(sub.id).status, "cancelled");
  close();
});

test("g15: reconcile leaves completed turns and completed runs untouched", () => {
  const { svc, close } = newService();
  const p = svc.createProject({ name: "p" });
  const main = svc.createRootConversation({ projectId: p.id });
  const t1 = svc.appendCompletedTurn({ branchId: main.id, userContent: "done", assistantContent: "ok" });
  const run = svc.openAgentRun({ ownerBranchId: main.id, ownerNodeId: t1.id, type: "main", name: "Main" });
  svc.completeAgentRun(run.id, "completed");
  const sessId = "sess-finished";
  svc.upsertRuntimeSession({ id: sessId, branchId: main.id, adapterType: "claude-cli", externalSessionId: "x", status: "stopped", lastSeenAt: new Date().toISOString() });

  const { cancelledNodes, interruptedSessions } = svc.reconcileTurnRuns();
  assert.equal(cancelledNodes, 0);
  assert.equal(interruptedSessions, 0);
  assert.equal(svc.getNode(t1.id).status, "completed");
  assert.equal(svc.getAgentRun(run.id).status, "completed");
  close();
});
