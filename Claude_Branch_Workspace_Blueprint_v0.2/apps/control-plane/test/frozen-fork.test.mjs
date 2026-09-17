// Phase 4 hard gate 1: FROZEN fork semantics. A branch is anchored to the exact
// node at which it was created; parent progress after the fork can never leak
// into the child.
//
// Scenario (from the plan): create Child at parent T2, continue parent through
// T5, then chat on Child => Child must NOT see T3–T5; the reconstruction
// snapshot is anchored to T2; Child's event set contains no parent >=T3 events.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeProject, makeRoot, setupService, fakeAdapter } from "./helpers.mjs";
import { SessionManager } from "../dist/session-manager.js";
import { ForkOrchestrator } from "../dist/fork-orchestrator.js";
import { runTurnOnce } from "../dist/turn-runner.js";

function turn(svc, sessionManager, adapter, bus, branchId, text, { keepAlive = false } = {}) {
  return sessionManager.resolveSession({ branchId, cwd: "C:\\fake\\cwd" }).then(async (st) => {
    const node = svc.openTurn({ branchId, userContent: text });
    const { result } = await runTurnOnce({ svc, bus, adapter, sessionKey: st.sessionKey, branchId, nodeId: node.id, runtimeSessionId: st.sessionKey, text });
    svc.completeTurn(node.id, { assistantContent: result.assistantContent, status: result.status === "cancelled" || result.status === "failed" ? "failed" : "completed" });
    if (!keepAlive) sessionManager.release(branchId);
    return { node, result };
  });
}

test("g1: eager fork freezes the snapshot at creation; parent T3-T5 never leak into the child", async () => {
  const { db, svc, repo, bus, close } = setupService();
  const adapter = fakeAdapter();
  const sm = new SessionManager(svc, adapter);
  const fo = new ForkOrchestrator(svc, sm, adapter);

  const p = makeProject(svc);
  const main = makeRoot(svc, p.id, "Main");

  // Parent T1, T2 (the head), keeping the parent session ALIVE so the fork can
  // take the native head-fork path (materialized parent).
  const t1 = await turn(svc, sm, adapter, bus, main.id, "T1", { keepAlive: true });
  const t2 = await turn(svc, sm, adapter, bus, main.id, "T2", { keepAlive: true });
  assert.equal(svc.lastNode(main.id).id, t2.node.id);
  assert.ok(sm.isBusy(main.id), "parent still materialized before fork");

  // Eager freeze at creation (parent is materialized + head fork -> native).
  const created = await fo.createFork({ projectId: p.id, forkFromNodeId: t2.node.id, displayName: "Child" });
  assert.equal(created.strategy, "native_head_fork");
  assert.ok(created.sessionKey, "child session bound eagerly at creation");
  assert.ok(created.snapshot, "snapshot captured at creation");
  assert.deepEqual(
    created.snapshot.ancestorNodeIds,
    [t1.node.id, t2.node.id],
    "snapshot anchored exactly to T1..T2",
  );
  assert.equal(created.snapshot.visibleMessages.length, 4, "T1 user/asst + T2 user/asst");

  // Parent keeps advancing after the fork (T3..T5).
  await turn(svc, sm, adapter, bus, main.id, "T3");
  await turn(svc, sm, adapter, bus, main.id, "T4");
  await turn(svc, sm, adapter, bus, main.id, "T5");
  assert.equal(svc.lastNode(main.id).localTurnIndex, 4, "parent is at T5");

  // Child chats now — must NOT see T3-T5.
  await turn(svc, sm, adapter, bus, created.branch.id, "C1");

  const conv = svc.getEffectiveConversation(created.branch.id);
  const contents = conv.map((m) => m.content);
  assert.ok(contents.includes("T1") && contents.includes("T2"), "child inherits through fork point");
  assert.ok(!contents.some((c) => c === "T3" || c === "T4" || c === "T5"), "child NEVER sees parent T3-T5");

  // Child's event set contains NO event attributed to a parent T3+ node and NO
  // leaked T3-T5 content (gate 1 no-leak on the observable surface).
  const t3plusIds = new Set(
    repo.listNodesByBranch(main.id)
      .filter((n) => n.localTurnIndex >= 2)
      .map((n) => n.id),
  );
  for (const ev of svc.listEventsByBranch(created.branch.id)) {
    assert.ok(!t3plusIds.has(ev.nodeId), `child event ${ev.type} never references parent T3+ node`);
    assert.ok(!JSON.stringify(ev.payloadJsonRedacted).includes("T3"), "child event payload never includes parent T3 content");
  }

  // exactly one seed per fork (B2): a single eager seed at creation.
  const seeds = adapter.calls.filter((c) => c[0] === "startSession" || c[0] === "reconstruct" || c[0] === "forkFromHead");
  assert.equal(seeds.length, 1, "exactly one eager seed per fork");
  close();
});

test("g1: historical fork (not head) uses reconstruction snapshot; parent never needs to be alive", async () => {
  const { db, svc, repo, bus, close } = setupService();
  const adapter = fakeAdapter();
  const sm = new SessionManager(svc, adapter);
  const fo = new ForkOrchestrator(svc, sm, adapter);

  const p = makeProject(svc);
  const main = makeRoot(svc, p.id, "Main");
  const t1 = await turn(svc, sm, adapter, bus, main.id, "T1");
  const t2 = await turn(svc, sm, adapter, bus, main.id, "T2");
  await turn(svc, sm, adapter, bus, main.id, "T3"); // head is now T3

  // Fork from HISTORICAL T1 (not the head) and AFTER releasing the parent
  // session — the parent never needs to be alive for reconstruction.
  sm.release(main.id);
  const created = await fo.createFork({ projectId: p.id, forkFromNodeId: t1.node.id, displayName: "Historic" });
  assert.equal(created.strategy, "replay_reconstruction");
  assert.deepEqual(created.snapshot.ancestorNodeIds, [t1.node.id], "anchored to T1 only");

  await turn(svc, sm, adapter, bus, created.branch.id, "H1");
  const conv = svc.getEffectiveConversation(created.branch.id);
  const contents = conv.map((m) => m.content);
  assert.ok(contents.includes("T1"), "inherits T1");
  assert.ok(!contents.some((c) => c === "T2" || c === "T3"), "does NOT inherit T2/T3 (before-or-at fork only)");
  close();
});
