// E2 regression (M1 review BLOCKER): the reconstruction seed a forked branch's
// session actually receives MUST contain the branch's full inherited history —
// including everything its PARENT itself inherited. The prior bug: fork-of-fork
// (A1 from A, where A forked from Main) seeded the model with ONLY A's local
// turns, dropping Main's prefix that the UI (getEffectiveConversation) still
// showed as inherited. The UI and the model disagreed.
//
// The D1 shape from the plan: Main 3 turns → A forks at Main T2 → A 1 turn →
// A1 forks at A T1. Both the read model AND the adapter seed are asserted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeProject, makeRoot, setupService, fakeAdapter } from "./helpers.mjs";
import { SessionManager } from "../dist/session-manager.js";
import { ForkOrchestrator } from "../dist/fork-orchestrator.js";
import { runTurnOnce } from "../dist/turn-runner.js";

async function turn(svc, sm, adapter, bus, branchId, text) {
  const st = await sm.resolveSession({ branchId, cwd: "C:\\fake\\cwd" });
  const node = svc.openTurn({ branchId, userContent: text });
  const { result } = await runTurnOnce({ svc, bus, adapter, sessionKey: st.sessionKey, branchId, nodeId: node.id, runtimeSessionId: st.sessionKey, text });
  svc.completeTurn(node.id, { assistantContent: result.assistantContent, status: result.status === "failed" || result.status === "cancelled" ? "failed" : "completed" });
  sm.release(branchId);
  return { node };
}

test("fork-of-fork: the adapter seed ⊇ the branch's inherited items and every ancestor prefix", async () => {
  const { svc, bus, close } = setupService();
  const adapter = fakeAdapter();
  const sm = new SessionManager(svc, adapter);
  const fo = new ForkOrchestrator(svc, sm, adapter);
  try {
    const p = makeProject(svc);
    const main = makeRoot(svc, p.id, "Main");

    // Main T1..T3
    const m1 = await turn(svc, sm, adapter, bus, main.id, "U_main_1");
    const m2 = await turn(svc, sm, adapter, bus, main.id, "U_main_2");
    await turn(svc, sm, adapter, bus, main.id, "U_main_3");

    // A forks at Main T2 (historical → reconstruction path, parent released).
    sm.release(main.id);
    const a = await fo.createFork({ projectId: p.id, forkFromNodeId: m2.node.id, displayName: "A" });

    // A gets TWO local turns so that A1's fork at A's FIRST turn is a HISTORICAL
    // fork (reconstruction seed) rather than a native head fork.
    const aT1 = await turn(svc, sm, adapter, bus, a.branch.id, "U_A_1");
    await turn(svc, sm, adapter, bus, a.branch.id, "U_A_2");
    sm.release(a.branch.id);

    // A1 forks at A's FIRST turn — the fork-of-fork the review named.
    const a1 = await fo.createFork({ projectId: p.id, forkFromNodeId: aT1.node.id, displayName: "A1" });

    // ---- read model (what the UI shows) ----
    const effective = svc.getEffectiveConversation(a1.branch.id).map((x) => x.content);

    // ---- seed (what the model actually received) ----
    // The historical fork path records the snapshot as adapter.calls[1].
    const reconstructions = adapter.calls.filter((c) => c[0] === "reconstruct");
    const lastSeedSnapshot = reconstructions[reconstructions.length - 1][1];
    const seedContents = lastSeedSnapshot.visibleMessages.map((m) => m.content);

    // The bug: A1's seed held only A's local turns, so Main's prefix vanished.
    assert.ok(effective.includes("U_main_1"), "read model: A1 inherits Main T1");
    assert.ok(effective.includes("U_main_2"), "read model: A1 inherits Main T2 (up to A's fork point)");
    assert.ok(!effective.includes("U_main_3"), "read model: A1 does NOT inherit Main T3 (after A's fork point)");
    assert.ok(effective.includes("U_A_1"), "read model: A1 inherits A's first turn (its fork point)");
    assert.ok(!effective.includes("U_A_2"), "read model: A1 does NOT inherit A's second turn (after fork)");

    // Every inherited item the UI shows must be present in the seed.
    for (const content of effective) {
      assert.ok(seedContents.includes(content), `seed ⊇ read model: missing "${content}"`);
    }

    // And the seed carries each ancestor's prefix explicitly.
    assert.ok(seedContents.includes("U_main_1") && seedContents.includes("U_main_2"), "seed ⊇ Main prefix");
    assert.ok(seedContents.includes("U_A_1"), "seed ⊇ A prefix");
    assert.ok(!seedContents.includes("U_main_3"), "seed never leaks past A1's ancestry boundary");
    assert.ok(!seedContents.includes("U_A_2"), "seed never leaks past A1's fork point");

    // Regression lock: the old buggy count was 2 (only A-local); correct is 6
    // (Main T1+T2 = 4 messages, A T1 = 2 messages).
    assert.equal(seedContents.length, 6, "seed has all 6 inherited messages (2 Main turns + 1 A turn)");
  } finally {
    close();
  }
});

test("fork-of-fork: snapshot.visibleMessages equals the read model's inherited set", async () => {
  const { svc, bus, close } = setupService();
  const adapter = fakeAdapter();
  const sm = new SessionManager(svc, adapter);
  const fo = new ForkOrchestrator(svc, sm, adapter);
  try {
    const p = makeProject(svc);
    const main = makeRoot(svc, p.id, "Main");
    const m1 = await turn(svc, sm, adapter, bus, main.id, "a");
    const m2 = await turn(svc, sm, adapter, bus, main.id, "b");
    sm.release(main.id);
    const a = await fo.createFork({ projectId: p.id, forkFromNodeId: m2.node.id, displayName: "A" });
    await turn(svc, sm, adapter, bus, a.branch.id, "c");
    sm.release(a.branch.id);
    const a1 = await fo.createFork({ projectId: p.id, forkFromNodeId: svc.lastNode(a.branch.id).id, displayName: "A1" });

    const snap = svc.getSnapshot(a1.branch.id);
    assert.ok(snap, "A1 has a snapshot");
    const effective = svc.getEffectiveConversation(a1.branch.id);

    // The snapshot is the pre-turn inherited context: it must contain exactly the
    // inherited items (A1 has no local turns yet, so effective IS all inherited).
    assert.deepEqual(
      snap.visibleMessages.map((m) => `${m.role}:${m.content}`),
      effective.map((e) => `${e.role}:${e.content}`),
      "snapshot seed and read model are identical for a fresh fork",
    );
    assert.equal(snap.visibleMessages.length, 6);
    assert.ok(m1.node.id && m2.node.id); // ancestors referenced
  } finally {
    close();
  }
});
