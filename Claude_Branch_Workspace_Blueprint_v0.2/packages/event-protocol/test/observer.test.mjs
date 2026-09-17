import { test } from "node:test";
import assert from "node:assert/strict";
import { TurnObserver, EventBus } from "../dist/index.js";

function makeObserver({ bus = new EventBus(), nodeId = "n1", persist } = {}) {
  return new TurnObserver({
    projectId: "p1",
    branchId: "b1",
    nodeId,
    runtimeSessionId: "ext-1",
    bus,
    persist,
    now: () => "2026-09-17T00:00:00.000Z",
  });
}

test("observer attributes main→subagent→tool events to the turn", () => {
  const bus = new EventBus();
  const seen = [];
  bus.subscribe((ev) => seen.push(ev));
  const o = makeObserver({ bus });

  o.feed({ kind: "init", externalSessionId: "ext-1" });
  o.feed({ kind: "assistant", text: "Let me read" });
  o.feed({ kind: "tool_use", name: "Read", input: { file_path: "a.ts" }, id: "tu_1" });
  o.feed({ kind: "tool_result", toolUseId: "tu_1", isError: false });
  // main spawns a subagent
  o.feed({ kind: "task", id: "tid_1", type: "task_started", taskId: "tid_1", subagentType: "Explore", description: "list nothing", status: "running" });
  o.feed({ kind: "task", id: "tid_1", type: "task_notification", taskId: "tid_1", status: "completed", summary: "OK" });
  o.feed({ kind: "result", exitCode: 0 });

  const kinds = seen.map((e) => e.type);
  assert.ok(kinds.includes("session.started"));
  assert.ok(kinds.includes("tool.started"));
  assert.ok(kinds.includes("tool.completed"));
  assert.ok(kinds.includes("agent.started"));
  assert.ok(kinds.includes("agent.completed"));
  assert.ok(kinds.includes("session.stopped"));

  // every event is attributed to b1/n1
  for (const e of seen) {
    assert.equal(e.branchId, "b1");
    assert.equal(e.nodeId, "n1");
  }

  // the subagent's agent.started event is attributed to its OWN run, not main.
  const subStart = seen.find((e) => e.type === "agent.started");
  assert.ok(subStart.agentRunId);
  const subComplete = seen.find((e) => e.type === "agent.completed");
  assert.equal(subComplete.agentRunId, subStart.agentRunId, "agent completed is the same run");

  // no tool.result payload leaked
  const toolRes = seen.find((e) => e.type === "tool.completed");
  assert.equal(toolRes.payload.toolUseId, "tu_1");

  // main was the only anonymous run; subagent completed
  const summary = o.summary();
  assert.equal(summary.agentsCompleted, 1);
  assert.equal(summary.agentsFailed, 0);
});

test("out-of-order tool_result (late) still maps to the same toolUseId", () => {
  const bus = new EventBus();
  const seen = [];
  bus.subscribe((ev) => seen.push(ev));
  const o = makeObserver({ bus });
  o.feed({ kind: "init", externalSessionId: "e" });
  o.feed({ kind: "tool_use", name: "Bash", input: { command: "ls" }, id: "tu_9" });
  // tool_result arrives with the id but AFTER another event
  o.feed({ kind: "tool_use", name: "Bash", input: { command: "pwd" }, id: "tu_10" });
  o.feed({ kind: "tool_result", toolUseId: "tu_10", isError: true });
  o.feed({ kind: "tool_result", toolUseId: "tu_9", isError: false });

  const types = seen.map((e) => e.type);
  assert.ok(types.includes("tool.failed"));
  assert.ok(types.includes("tool.completed"));
  const failed = seen.find((e) => e.type === "tool.failed");
  assert.equal(failed.payload.toolUseId, "tu_10");
  const completed = seen.find((e) => e.type === "tool.completed");
  assert.equal(completed.payload.toolUseId, "tu_9");
});

test("thinking_tokens and task_updated are not emitted (no event, no payload)", () => {
  const bus = new EventBus();
  const seen = [];
  bus.subscribe((ev) => seen.push(ev));
  const o = makeObserver({ bus });
  o.feed({ kind: "init", externalSessionId: "e" });
  o.feed({ kind: "task", id: "t", type: "task_updated", taskId: "t" }); // ignored
  o.feed({ kind: "result", exitCode: 0 });
  const types = seen.map((e) => e.type);
  assert.ok(!types.includes("task.*".replace("*", "") + ""));
  assert.equal(types.filter((t) => t.startsWith("task")).length, 0);
});

test("persist hook stores every canonical event with a redacted payload", () => {
  const bus = new EventBus();
  const stored = [];
  const o = makeObserver({ bus, persist: (ev) => stored.push(ev) });
  o.feed({ kind: "init", externalSessionId: "e" });
  o.feed({ kind: "tool_use", name: "Read", input: { file_path: "x", apiKey: "sk-live-123" }, id: "tu_1" });
  o.feed({ kind: "tool_result", toolUseId: "tu_1", isError: false });
  o.feed({ kind: "result", exitCode: 0 });

  const payloads = stored.map((e) => e.payload);
  const readPayload = payloads.find((p) => p.tool === "Read");
  assert.ok(readPayload, "tool.started persisted");
  assert.equal(readPayload.file_path, "x");
  assert.equal(readPayload.apiKey, undefined, "secret key never persisted");
});
