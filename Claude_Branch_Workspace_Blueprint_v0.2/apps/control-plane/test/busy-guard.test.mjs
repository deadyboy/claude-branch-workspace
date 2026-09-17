// Phase 4 hard gate 11 (per-branch serialization): a branch already running one
// turn must not open a second turn. The POST /messages route 409s while a turn
// node is in flight (reviewer MAJOR fix). Busy = a turn in flight (hasActiveTurn
// = state.nodeId set); an eagerly-adopted-but-idle fork child is NOT busy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setupService, fakeAdapter } from "./helpers.mjs";
import { SessionManager } from "../dist/session-manager.js";
import { ForkOrchestrator } from "../dist/fork-orchestrator.js";
import { AttentionRegistry } from "../dist/attention-registry.js";
import { buildApp } from "../dist/server.js";

test("g11: claimTurn closes the TOCTOU — sync in-flight flag visible before any await; drained on resolve, cleared on release", async () => {
  const { svc, repo, bus, close } = setupService();
  const adapter = fakeAdapter();
  const sm = new SessionManager(svc, adapter);

  const p = svc.createProject({ name: "g11-claim" });
  const main = svc.createRootConversation({ projectId: p.id, rootBranchName: "Main" });

  // (1) Synchronous claim: a concurrent POST must see the branch busy IMMEDIATELY,
  // before runTurnAsync's first await (startSession spawn). This is what closes
  // the first-message double-open window the security/concurrency review found.
  const node = svc.openTurn({ branchId: main.id, userContent: "first" });
  sm.claimTurn(main.id, node.id);
  assert.equal(sm.hasActiveTurn(main.id), true, "claim visible synchronously, no await");

  // (2) resolveSession drains the claim into materialized state — nodeId carried
  // over, claim removed, and the branch STAYS busy throughout (claim → drain → nodeId).
  const st = await sm.resolveSession({ branchId: main.id, cwd: "C:\\fake\\cwd" });
  assert.equal(st.nodeId, node.id, "claim nodeId transferred into materialized state");
  assert.equal(sm.hasPendingClaim(main.id), false, "claim drained after resolve");
  assert.equal(sm.hasActiveTurn(main.id), true, "state.nodeId keeps the branch busy");

  // (3) A second openTurn would 409 (the route does this via hasActiveTurn).
  // (4) release clears both the state and any leftover claim.
  sm.release(main.id);
  assert.equal(sm.hasActiveTurn(main.id), false, "released branch is no longer busy");
  assert.equal(sm.hasPendingClaim(main.id), false, "leftover claim cleared on release");
  assert.equal(repo.listNodesByBranch(main.id).length, 1, "exactly one turn node opened");

  await close();
});

test("g11: a second turn on a busy branch is 409; unrelated branch and adopted-but-idle child are not blocked", async () => {
  const { svc, repo, bus, close } = setupService();
  const adapter = fakeAdapter();
  const sm = new SessionManager(svc, adapter);
  const fo = new ForkOrchestrator(svc, sm, adapter);
  const attention = new AttentionRegistry();
  const app = await buildApp({ ctx: { db: null, svc, repo, bus, sessionManager: sm, forkOrchestrator: fo, attention, adapter }, logger: false });
  await app.ready();

  const p = svc.createProject({ name: "g11-busy" });
  const main = svc.createRootConversation({ projectId: p.id, rootBranchName: "Main" });

  // Resolve the session (binds Main) then open a turn node. This is the same
  // reservation state runTurnAsync produces after openTurn: a node in flight.
  await sm.resolveSession({ branchId: main.id, cwd: "C:\\fake\\cwd" });
  const node = svc.openTurn({ branchId: main.id, userContent: "first" });
  sm.markNode(main.id, node.id);
  assert.equal(sm.hasActiveTurn(main.id), true, "branch has an active turn");

  // While a turn is in flight, a second message must be rejected — no second
  // node may be opened.
  const r2 = await app.inject({
    method: "POST",
    url: `/api/branches/${main.id}/messages`,
    payload: { text: "second" },
  });
  assert.equal(r2.statusCode, 409, "second turn on the same busy branch rejected");
  assert.match(r2.json()["error"] ?? "", /busy/i, "409 names the busy state");
  assert.equal(repo.listNodesByBranch(main.id).length, 1, "no second turn node opened");

  // A THIRD branch is NOT blocked (per-branch serialization ≠ global lock).
  const other = svc.createRootConversation({ projectId: p.id, rootBranchName: "Other" });
  const rOther = await app.inject({
    method: "POST",
    url: `/api/branches/${other.id}/messages`,
    payload: { text: "hello" },
  });
  assert.equal(rOther.statusCode, 202, "unrelated branch not serialized behind Main");

  // An eagerly-adopted child (bound session, no turn started) is NOT busy — the
  // fork's first message must open normally (this is what broke the E2E).
  const child = svc.createRootConversation({ projectId: p.id, rootBranchName: "Child" });
  const adopted = await adapter.reconstructBranchFromHistory(
    { visibleMessages: [], projectInstructions: null },
    { newSessionId: "child-key-1", cwd: "C:\\fake\\cwd" }
  );
  sm.adoptSession(child.id, adopted);
  assert.equal(sm.hasActiveTurn(child.id), false, "adopted-but-idle child is not busy");
  const rChild = await app.inject({
    method: "POST",
    url: `/api/branches/${child.id}/messages`,
    payload: { text: "hello" },
  });
  assert.equal(rChild.statusCode, 202, "adopted child's first message accepted (not falsely 409)");

  await app.close();
  close();
});
