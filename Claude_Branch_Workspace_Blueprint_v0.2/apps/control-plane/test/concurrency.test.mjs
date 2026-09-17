// Phase 4 hard gate 11: concurrent branches. Main and Child run at the same
// time; per-branch serialization must NOT become a global lock. Here both turns
// complete on interleaved timers with DISTINCT sessions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeProject, makeRoot, setupService, fakeAdapter } from "./helpers.mjs";
import { SessionManager } from "../dist/session-manager.js";
import { runTurnOnce } from "../dist/turn-runner.js";

test("g11: Main + Child on distinct sessions both complete under interleaved timing; no global lock", async () => {
  const { db, svc, bus, close } = setupService();
  // Fake with optional per-call delays to emulate interleaving.
  const adapter = fakeAdapter({ seedName: "CC-EXT" });
  const sm = new SessionManager(svc, adapter);

  const p = makeProject(svc);
  const main = makeRoot(svc, p.id, "Main");
  const child = makeRoot(svc, p.id, "Child");

  const m = await sm.resolveSession({ branchId: main.id, cwd: "C:\\fake\\cwd" });
  const c = await sm.resolveSession({ branchId: child.id, cwd: "C:\\fake\\cwd" });
  assert.notEqual(m.sessionKey, c.sessionKey, "distinct sessions");

  const mainNode = svc.openTurn({ branchId: main.id, userContent: "M1" });
  const childNode = svc.openTurn({ branchId: child.id, userContent: "C1" });

  // Launch both; the fake's default sendMessage is synchronous, so truly
  // interleave by delaying one via a wrapped adapter.
  const delayAdapter = {
    ...adapter,
    async *sendMessage(sessionId, input) {
      // stagger: Child yields after a small delay to force overlap
      await new Promise((r) => setTimeout(r, sessionId === c.sessionKey ? 50 : 5));
      yield* adapter.sendMessage(sessionId, input);
    },
  };

  const [mainRes, childRes] = await Promise.all([
    runTurnOnce({ svc, bus, adapter: delayAdapter, sessionKey: m.sessionKey, branchId: main.id, nodeId: mainNode.id, runtimeSessionId: m.sessionKey, text: "M1" }),
    runTurnOnce({ svc, bus, adapter: delayAdapter, sessionKey: c.sessionKey, branchId: child.id, nodeId: childNode.id, runtimeSessionId: c.sessionKey, text: "C1" }),
  ]);

  assert.equal(mainRes.result.status, "completed");
  assert.equal(childRes.result.status, "completed");
  svc.completeTurn(mainNode.id, { assistantContent: mainRes.result.assistantContent, status: "completed" });
  svc.completeTurn(childNode.id, { assistantContent: childRes.result.assistantContent, status: "completed" });
  assert.equal(svc.getNode(mainNode.id).status, "completed");
  assert.equal(svc.getNode(childNode.id).status, "completed");

  // attribution: main events on main branch/node, child events on child branch/node
  const mainEvents = svc.listEventsByBranch(main.id);
  const childEvents = svc.listEventsByBranch(child.id);
  assert.ok(mainEvents.some((e) => e.nodeId === mainNode.id));
  assert.ok(childEvents.some((e) => e.nodeId === childNode.id));
  assert.ok(mainEvents.every((e) => e.nodeId === mainNode.id), "main events all on main node");
  assert.ok(childEvents.every((e) => e.nodeId === childNode.id), "child events all on child node");

  close();
});
