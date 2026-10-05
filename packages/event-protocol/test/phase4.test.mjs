import { test } from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "../dist/event-bus.js";
import { TurnObserver } from "../dist/observer.js";
import { buildRedactedPayload } from "../dist/redact.js";

function mkObserver(over = {}) {
  const bus = new EventBus();
  const seen = [];
  const observer = new TurnObserver({
    projectId: "p",
    branchId: "b",
    nodeId: "n",
    runtimeSessionId: "r",
    bus,
    now: () => "2026-09-17T00:00:00.000Z",
    persist: (ev) => seen.push(ev),
    ...over,
  });
  return { observer, bus, seen };
}

// Phase 4 gate 4 (observability side): userMessage emits a scrubbed message.user.
test("g4: observer.userMessage emits scrubbed message.user", () => {
  const { observer, seen } = mkObserver();
  const ev = observer.userMessage("apply the patch and rerun");
  assert.equal(ev.type, "message.user");
  assert.equal(ev.payload.text, "apply the patch and rerun");
  assert.equal(seen.length, 1);

  // a secret-shaped value is scrubbed (whole-string, the established convention)
  const KEY = "sk-live-ABCDEFG123456789XYZ";
  const ev2 = observer.userMessage(`use key ${KEY} to auth`);
  assert.equal(ev2.payload.text, "[REDACTED]");
});

// Phase 4 gate 6: cancel marks the turn cancelled on the canonical surface.
test("g6: observer.cancel emits session.stopped with status cancelled", () => {
  const { observer, seen } = mkObserver();
  const ev = observer.cancel();
  assert.equal(ev.type, "session.stopped");
  assert.equal(ev.status, "cancelled");
  assert.equal(seen.length, 1);
  // feed after cancel is ignored (turn already terminated)
  const after = observer.feed({ kind: "assistant", text: "late" });
  assert.equal(after.length, 0);
});

// Phase 4 gate 2 (surface): Bash output is now allowlisted (scrubbed) so tool
// results are observable; a secret inside output is still redacted.
test("g2: Bash output allowlisted and scrubbed", () => {
  const base = {
    eventId: "x", type: "tool.completed", occurredAt: "t", receivedAt: "t",
    projectId: "p", branchId: "b", nodeId: null, agentRunId: null, runtimeSessionId: "r", sequence: 1,
  };
  const KEY = "sk-live-ABCDEFG123456789XYZ";
  const p = buildRedactedPayload({
    ...base, toolName: "Bash",
    toolInput: { command: "cat config", output: `token ${KEY} found` },
  });
  assert.equal(p.command, "cat config");
  // whole-string replacement is the established scrub convention (redaction.test.mjs)
  assert.equal(p.output, "[REDACTED]");
  // unknown tool still yields empty payload
  const unknown = buildRedactedPayload({ ...base, toolName: "Kubernetes", toolInput: { output: "secret" } });
  assert.equal(unknown.output, undefined);
});
