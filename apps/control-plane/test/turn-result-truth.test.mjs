// Phase 4 hard gate 4: TurnResult is the CHAT TRUTH. Runtime execution returns
// a structured TurnResult; CanonicalEvents are observability only.
//
// Policy (reviewer B1): messages.visible_content is USER-AUTHORED chat truth —
// the same surface Claude Code leaves in the user's terminal/transcripts — so a
// command *containing* a secret (e.g. `export KEY=sk-…`) persists VERBATIM on the
// parent. Child branches never inherit it (gate 1 no-leak). defense-in-depth: a
// whole-string secret-shaped value as the ENTIRE assistant reply is still replaced.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeProject, makeRoot, setupService, fakeAdapter } from "./helpers.mjs";
import { SessionManager } from "../dist/session-manager.js";
import { ForkOrchestrator } from "../dist/fork-orchestrator.js";
import { runTurnOnce } from "../dist/turn-runner.js";

const KEY = "sk-CBWTEST-1234567890ABCDEF"; // a secret-shaped value

function turn(svc, sessionManager, adapter, bus, branchId, text, { keepAlive = false, custom = null } = {}) {
  return sessionManager.resolveSession({ branchId, cwd: "C:\\fake\\cwd" }).then(async (st) => {
    const node = svc.openTurn({ branchId, userContent: text });
    const a = custom ? { ...adapter, ...custom } : adapter;
    const { result } = await runTurnOnce({ svc, bus, adapter: a, sessionKey: st.sessionKey, branchId, nodeId: node.id, runtimeSessionId: st.sessionKey, text });
    svc.completeTurn(node.id, { assistantContent: result.assistantContent, status: result.status === "completed" ? "completed" : "failed" });
    if (!keepAlive) sessionManager.release(branchId);
    return { node, result };
  });
}

test("g4: verbatim assistant text captured pre-scrub; ChatTruth = TurnResult", async () => {
  const { svc, bus, close } = setupService();
  const adapter = fakeAdapter();
  const sm = new SessionManager(svc, adapter);

  const p = makeProject(svc);
  const main = makeRoot(svc, p.id, "Main");

  // A parent turn whose assistant reply CONTAINS the secret (auth command).
  // Because this is the parent's authored surface, it persists verbatim.
  const custom = {
    async *sendMessage() {
      yield { kind: "init", externalSessionId: "SEC-EXT" };
      yield { kind: "assistant", text: `export KEY=${KEY} then run` };
      yield { kind: "tool_use", name: "Bash", input: { command: "run --token ${KEY}", output: `ok ${KEY}` }, id: "tu_s1" };
      yield { kind: "assistant", text: "logout" };
      yield { kind: "result", exitCode: 0 };
    },
  };
  const sess = await sm.resolveSession({ branchId: main.id, cwd: "C:\\fake\\cwd" });

  const node = svc.openTurn({ branchId: main.id, userContent: "auth please" });
  const { result } = await runTurnOnce({ svc, bus, adapter: { ...adapter, ...custom }, sessionKey: sess.sessionKey, branchId: main.id, nodeId: node.id, runtimeSessionId: sess.sessionKey, text: "auth" });
  svc.completeTurn(node.id, { assistantContent: result.assistantContent, status: "completed" });
  sm.release(main.id);

  assert.equal(result.status, "completed");
  // Every distinct full assistant message is persisted, including after tools.
  assert.equal(result.assistantContent, "export KEY=sk-CBWTEST-1234567890ABCDEF then run\nlogout");

  // Chat truth persists VERBATIM (no key-based redaction of ordinary text):
  const asst = svc.getEffectiveConversation(main.id).find((m) => m.role === "assistant");
  assert.equal(asst.content, "export KEY=sk-CBWTEST-1234567890ABCDEF then run\nlogout", "chat truth verbatim");

  // The OBSERVABLE canonical events are scrubbed (redaction is observability-only)
  const persisted = svc.listEventsByBranch(main.id);
  const noSecret = persisted.every((e) => !JSON.stringify(e.payloadJsonRedacted).includes(KEY));
  assert.ok(noSecret, "no canonical event carries the secret");
  close();
});

test("g4: whole-string secret-shaped assistant reply is replaced (defense-in-depth)", async () => {
  const { db, svc, bus, close } = setupService();
  const adapter = fakeAdapter();
  const sm = new SessionManager(svc, adapter);
  const sess = await sm.resolveSession({ branchId: makeRoot(svc, makeProject(svc).id).id, cwd: "C:\\fake\\cwd" });

  const custom = {
    async *sendMessage() {
      yield { kind: "init", externalSessionId: "RAW-EXT" };
      yield { kind: "assistant", text: KEY }; // ENTIRE reply is a bare secret
      yield { kind: "result", exitCode: 0 };
    },
  };
  const node = svc.openTurn({ branchId: sess.branchId, userContent: "give key" });
  const { result } = await runTurnOnce({ svc, bus, adapter: { ...adapter, ...custom }, sessionKey: sess.sessionKey, branchId: sess.branchId, nodeId: node.id, runtimeSessionId: sess.sessionKey, text: "give key" });
  svc.completeTurn(node.id, { assistantContent: result.assistantContent, status: "completed" });

  const conv = svc.getEffectiveConversation(sess.branchId);
  const asst = conv.find((m) => m.role === "assistant");
  assert.equal(asst.content, "[REDACTED]", "bare pasted secret replaced in chat truth");
  close();
});

test("g4 + g1: secret absent from the child branch's EVENT set after fork; no parent T3+ events", async () => {
  const { db, svc, bus, close } = setupService();
  const adapter = fakeAdapter();
  const sm = new SessionManager(svc, adapter);
  const fo = new ForkOrchestrator(svc, sm, adapter);

  const p = makeProject(svc);
  const main = makeRoot(svc, p.id, "Main");
  await turn(svc, sm, adapter, bus, main.id, "T1");

  const custom = {
    async *sendMessage() {
      yield { kind: "init", externalSessionId: "SEC-EXT" };
      yield { kind: "assistant", text: `use key ${KEY} now` };
      yield { kind: "result", exitCode: 0 };
    },
  };
  const sess = await sm.resolveSession({ branchId: main.id, cwd: "C:\\fake\\cwd" });
  const n2 = svc.openTurn({ branchId: main.id, userContent: "T2 w/ key" });
  await runTurnOnce({ svc, bus, adapter: { ...adapter, ...custom }, sessionKey: sess.sessionKey, branchId: main.id, nodeId: n2.id, runtimeSessionId: sess.sessionKey, text: "T2" });
  svc.completeTurn(n2.id, { assistantContent: "use key sk-CBWTEST-1234567890ABCDEF now", status: "completed" });
  // keep parent alive did not happen: release so fork takes reconstruction; either
  // way the child EVENT set must be clean.
  sm.release(main.id);
  await turn(svc, sm, adapter, bus, main.id, "T3", { keepAlive: true });

  const created = await fo.createFork({ projectId: p.id, forkFromNodeId: n2.id, displayName: "Child" });
  // Child's local turn
  await turn(svc, sm, adapter, bus, created.branch.id, "C1");

  // Gate-4/Gate-1 no-leak: the child branch's EVENT SET has no trace of the
  // parent secret (redaction is observability-only; events are scrubbed).
  const childEvents = svc.listEventsByBranch(created.branch.id);
  assert.ok(
    childEvents.every((e) => !JSON.stringify(e.payloadJsonRedacted).includes(KEY)),
    "child event set carries no trace of the parent secret",
  );

  // Fork-point cutoff: no child event references a parent T3+ node.
  const t3NodeId = svc.lastNode(main.id).id;
  for (const ev of childEvents) {
    assert.notEqual(ev.nodeId, t3NodeId, "child events never reference the parent's post-fork T3 node");
  }
  close();
});
