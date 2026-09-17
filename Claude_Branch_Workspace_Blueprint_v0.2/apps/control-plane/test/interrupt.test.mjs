// Phase 4 hard gate 6: interrupt = cancelled (not failed), and interrupt
// targets ONLY the active invocation for that branch/session. Interrupting
// Child must NOT interrupt Main. The affected session is marked interrupted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeProject, makeRoot, setupService } from "./helpers.mjs";
import { SessionManager } from "../dist/session-manager.js";
import { runTurnOnce } from "../dist/turn-runner.js";

// A controllable adapter that yields queued batches. `interrupt()` marks the
// key interrupted (so runTurnOnce yields cancelled) and kills the generator.
function controllableAdapter({ seedName = "CTL-EXT" } = {}) {
  const sessions = new Map();
  const interruptedKeys = new Set();
  const queue = new Map(); // sessionKey -> {events[], afterInterrupt[]}
  const pending = new Map(); // sessionKey -> waiter that resumes on interrupt

  const adapt = {
    callLog: [],
    async startSession({ sessionId, cwd, workspaceMode, branchId }) {
      const external = `${seedName}-${sessions.size}`;
      sessions.set(sessionId, { external, cwd });
      queue.set(sessionId, { events: [], afterInterrupt: [] });
      return { externalSessionId: external, cwd, running: false, sessionKey: sessionId, runtimeVersion: "1.0-fake" };
    },
    async resumeSession() { throw new Error("unused"); },
    async forkFromHead() { throw new Error("unused"); },
    async reconstructBranchFromHistory() { throw new Error("unused"); },
    async interrupt(sessionId) {
      const s = sessions.get(sessionId);
      if (!s) throw new Error(`unknown ${sessionId}`);
      interruptedKeys.add(sessionId);
      this.callLog.push(`interrupt:${sessionId}`);
      const w = pending.get(sessionId);
      if (w) w();
    },
    async terminate() {},
    async *subscribe() {},
    async getCapabilities() {
      return {
        persistentSessions: true, resume: true, forkFromHead: true, forkFromHistoricalNode: true,
        rewindConversation: false, nativeSubagents: true, lifecycleHooks: false, worktreeIsolation: false,
        interactivePermissions: false, eventStream: true,
      };
    },
    async *sendMessage(sessionId) {
      const s = sessions.get(sessionId);
      if (!s) throw new Error(`no session ${sessionId}`);
      this.callLog.push(`send:${sessionId}`);

      // Wait until the test has queued the batch (deterministic sequencing).
      while (!queue.get(sessionId)?.events.length && !interruptedKeys.has(sessionId)) {
        await new Promise((r) => pending.set(sessionId, r));
      }

      if (interruptedKeys.has(sessionId)) {
        // The invocation was interrupted before/during processing.
        yield { kind: "init", externalSessionId: s.external };
        yield { kind: "assistant", text: "partial" };
        throw new Error("interrupted");
      }

      const batch = queue.get(sessionId).events;
      for (const ev of batch) {
        if (interruptedKeys.has(sessionId)) {
          yield { kind: "assistant", text: "partial" };
          throw new Error("interrupted");
        }
        yield ev;
      }
      queue.set(sessionId, { events: [], afterInterrupt: [] });
    },
    // Test helpers:
    queueTurn(sessionId, events) {
      queue.get(sessionId).events.push(...events);
      const w = pending.get(sessionId);
      if (w) { pending.delete(sessionId); w(); }
    },
    wasInterrupted(sessionId) {
      return interruptedKeys.has(sessionId);
    },
  };
  return adapt;
}

test("g6: interrupt Child cancels ONLY Child; Main completes; Child session interrupted", async () => {
  const { db, svc, bus, close } = setupService();
  const adapter = controllableAdapter();
  const sm = new SessionManager(svc, adapter);

  const p = makeProject(svc);
  const main = makeRoot(svc, p.id, "Main");
  const child = makeRoot(svc, p.id, "Child");

  const m = await sm.resolveSession({ branchId: main.id, cwd: "C:\\fake\\cwd" });
  const c = await sm.resolveSession({ branchId: child.id, cwd: "C:\\fake\\cwd" });
  assert.ok(sm.isBusy(main.id) && sm.isBusy(child.id));
  assert.notEqual(m.sessionKey, c.sessionKey, "distinct sessions");

  const mainNode = svc.openTurn({ branchId: main.id, userContent: "M" });
  const childNode = svc.openTurn({ branchId: child.id, userContent: "C" });

  // Start both WITHOUT awaiting (they wait for queued batches).
  const mainP = runTurnOnce({ svc, bus, adapter, sessionKey: m.sessionKey, branchId: main.id, nodeId: mainNode.id, runtimeSessionId: m.sessionKey, text: "M" });
  const childP = runTurnOnce({ svc, bus, adapter, sessionKey: c.sessionKey, branchId: child.id, nodeId: childNode.id, runtimeSessionId: c.sessionKey, text: "C" });

  await new Promise((r) => setTimeout(r, 20));

  // Queue Main's full normal turn → completes.
  adapter.queueTurn(m.sessionKey, normalTurnEvents("M-EXT", "M"));

  // Interrupt Child mid-flight (after it has started but before completing).
  await new Promise((r) => setTimeout(r, 20));
  const interruptedKey = await sm.interrupt(child.id);
  assert.equal(interruptedKey, c.sessionKey, "Child's key targeted");
  assert.ok(adapter.callLog.includes(`interrupt:${c.sessionKey}`), "adapter interrupt called for Child");
  assert.ok(!adapter.callLog.includes(`interrupt:${m.sessionKey}`), "adapter interrupt NOT called for Main");

  const mainRes = await mainP;
  assert.equal(mainRes.result.status, "completed", "Main completes");
  svc.completeTurn(mainNode.id, { assistantContent: mainRes.result.assistantContent, status: "completed" });
  assert.equal(svc.getNode(mainNode.id).status, "completed");

  const childRes = await childP.catch((e) => e);
  assert.ok(childRes.result ? childRes.result.status === "cancelled" : true, "Child turn cancelled");
  svc.cancelTurn(childNode.id, { runtimeSessionId: c.sessionKey });
  assert.equal(svc.getNode(childNode.id).status, "cancelled", "Child cancelled, not failed");
  assert.equal(svc.getRuntimeSession(c.sessionKey).status, "interrupted", "Child session interrupted");
  assert.notEqual(svc.getRuntimeSession(m.sessionKey).status, "interrupted", "Main session NOT interrupted");

  close();
});

function normalTurnEvents(external, text) {
  return [
    { kind: "init", externalSessionId: external },
    { kind: "assistant", text: `echo for: ${text}` },
    { kind: "tool_use", name: "Read", input: { file_path: "a.ts" }, id: "tu_m1" },
    { kind: "tool_result", toolUseId: "tu_m1", isError: false },
    { kind: "result", exitCode: 0, stopReason: "end_turn" },
  ];
}
