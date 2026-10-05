// Phase 4 hard gate 9: attribution honesty. Do NOT attribute a tool/event to a
// specific AgentRun without a verified runtime ownership mapping. The UI renders
// tools at branch/turn level ONLY (reviewer S1: tool→AgentRun attribution exists
// via TurnObserver agentRunId but is UNRELIABLE — dropped task_updated patches,
// ordering ambiguity). `agent.message` is shown only with explicit runtime
// sender/receiver ids — never "Agent X is reading file Y".
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeProject, makeRoot, setupService, fakeAdapter } from "./helpers.mjs";
import { SessionManager } from "../dist/session-manager.js";
import { runTurnOnce } from "../dist/turn-runner.js";

function runOneTurn(svc, bus, adapter, branchId, text) {
  return sessionManagerOf(svc, adapter)
    .resolveSession({ branchId, cwd: "C:\\fake\\cwd" })
    .then((st) => {
      const node = svc.openTurn({ branchId, userContent: text });
      return runTurnOnce({ svc, bus, adapter, sessionKey: st.sessionKey, branchId, nodeId: node.id, runtimeSessionId: st.sessionKey, text }).then((out) => {
        svc.completeTurn(node.id, { assistantContent: out.result.assistantContent, status: "completed" });
        return { node, sessionKey: st.sessionKey };
      });
    });
}

function sessionManagerOf(svc, adapter) {
  return new SessionManager(svc, adapter);
}

test("g9: observable surface is honest — events anchor at branch+turn, no fabricated agent prose", async () => {
  const { db, svc, bus, close } = setupService();
  const adapter = fakeAdapter();
  const sm = new SessionManager(svc, adapter);
  const p = makeProject(svc);
  const main = makeRoot(svc, p.id, "Main");
  const { node } = await runOneTurn(svc, bus, adapter, main.id, "go");

  const branchEvents = svc.listEventsByBranch(main.id);
  assert.ok(branchEvents.length > 0);
  for (const ev of branchEvents) {
    assert.equal(ev.branchId, main.id, "every event carries branch id");
    assert.equal(ev.nodeId, node.id, "every event carries the turn node id (branch/turn render anchor)");
  }

  // Tool payloads carry only the allowlisted tool + input; the frame-level
  // render (branch/turn only) is the UI's decision — no fabricated agent prose.
  for (const ev of branchEvents.filter((e) => e.type.startsWith("tool."))) {
    const payload = JSON.parse(ev.payloadJsonRedacted);
    assert.ok(!/Agent\s+\w+ is/i.test(JSON.stringify(payload)), "no fabricated 'Agent X is ...' in tool payload");
    assert.ok(!("agentDisplayName" in payload), "tool payload does not fabricate an agent claim field");
  }
  close();
});

test("g9: no agent.message surfaces without explicit sender+receiver runtime ids", async () => {
  const { db, svc, bus, close } = setupService();
  const adapter = fakeAdapter();
  const sm = new SessionManager(svc, adapter);
  const p = makeProject(svc);
  const main = makeRoot(svc, p.id, "Main");
  await runOneTurn(svc, bus, adapter, main.id, "x");

  const events = svc.listEventsByBranch(main.id);
  // No agent.message may EVER be emitted without explicit sender+receiver ids;
  // the canonical surface from a full turn simply never originates one.
  assert.equal(
    events.filter((e) => e.type === "agent.message").length,
    0,
    "no agent.message (which needs explicit runtime sender+receiver ids) is ever emitted",
  );
  close();
});
