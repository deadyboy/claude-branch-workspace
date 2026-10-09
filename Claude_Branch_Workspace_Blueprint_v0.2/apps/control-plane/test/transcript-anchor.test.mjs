import { test } from "node:test";
import assert from "node:assert/strict";
import { setupService, makeProject, makeRoot } from "./helpers.mjs";
import { runTurnOnce } from "../dist/turn-runner.js";
import { turnExecution } from "../dist/turn-execution.js";

function fixture(t, events, { interrupted = false } = {}) {
  const context = setupService();
  t.after(context.close);
  const branch = makeRoot(context.svc, makeProject(context.svc).id);
  const node = context.svc.openTurn({ branchId: branch.id, userContent: "go" });
  const adapter = {
    async *sendMessage() { yield* events; },
    wasInterrupted: () => interrupted,
  };
  return { ...context, branch, node, adapter };
}

async function run(context) {
  return runTurnOnce({
    svc: context.svc, bus: context.bus, adapter: context.adapter,
    branchId: context.branch.id, nodeId: context.node.id,
    sessionKey: "session", runtimeSessionId: null, text: "go",
  });
}

test("captures last transcript UUID while assistant text dedup still uses API messageId", async t => {
  const context = fixture(t, [
    { kind: "assistant", messageId: "api-1", transcriptUuid: "uuid-1", text: "Checking" },
    { kind: "tool_use", name: "Read", input: {} },
    { kind: "assistant", messageId: "api-2", transcriptUuid: "uuid-2", text: "Final" },
    { kind: "assistant", messageId: "api-2", transcriptUuid: "uuid-3", text: "Final updated" },
    { kind: "assistant", messageId: "api-3", transcriptUuid: "uuid-3", text: "Final updated" },
    { kind: "result", exitCode: 0 },
  ]);
  const { result } = await run(context);
  assert.equal(result.runtimeAssistantMessageId, "uuid-3");
  assert.equal(result.assistantContent, "Checking\nFinal updated\nFinal updated");
});

test("final tool-only assistant UUID advances the anchor without adding visible content", async t => {
  const context = fixture(t, [
    { kind: "assistant", messageId: "api-1", transcriptUuid: "uuid-text", text: "Working" },
    { kind: "assistant", messageId: "api-tool", transcriptUuid: "uuid-tool", text: "" },
    { kind: "tool_use", name: "Read", input: {} },
    { kind: "result", exitCode: 0 },
  ]);
  const { result } = await run(context);
  assert.equal(result.runtimeAssistantMessageId, "uuid-tool");
  assert.equal(result.assistantContent, "Working");
  assert.equal(context.svc.listEventsByNode(context.node.id).filter(e => e.type === "message.assistant.completed").length, 1,
    "anchor-only records do not add blank Timeline entries");
});

test("legacy assistant events do not mistake API messageId for a transcript UUID", async t => {
  const context = fixture(t, [
    { kind: "assistant", messageId: "api-message-only", text: "Answer" },
    { kind: "result", exitCode: 0 },
  ]);
  assert.equal((await run(context)).result.runtimeAssistantMessageId, null);
});

test("a final assistant without UUID clears an earlier anchor", async t => {
  const context = fixture(t, [
    { kind: "assistant", transcriptUuid: "earlier-uuid", text: "Earlier" },
    { kind: "assistant", messageId: "final-api", text: "Final" },
    { kind: "result", exitCode: 0 },
  ]);
  assert.equal((await run(context)).result.runtimeAssistantMessageId, null);
});

for (const [name, terminal, interrupted] of [
  ["failed", [{ kind: "result", exitCode: 1 }], false],
  ["cancelled", [], true],
]) {
  test(`${name} execution exposes no transcript anchor`, async t => {
    const context = fixture(t, [
      { kind: "assistant", transcriptUuid: "unsafe-uuid", text: "Partial" }, ...terminal,
    ], { interrupted });
    const { result } = await run(context);
    assert.equal(result.status, name);
    assert.equal(result.runtimeAssistantMessageId, null);
  });
}

test("ordinary turn execution carries the UUID through to durable node and assistant message", async t => {
  const context = fixture(t, [
    { kind: "assistant", messageId: "api-1", transcriptUuid: "durable-uuid", text: "Answer" },
    { kind: "result", exitCode: 0 },
  ]);
  const sessionManager = {
    async resolveSession() { return { sessionKey: "session", cancelRequested: false }; },
    release() {},
    isCancellationRequested() { return false; },
  };
  context.svc.upsertRuntimeSession({
    id: "session", branchId: context.branch.id, adapterType: "claude-cli",
    externalSessionId: "external-session", status: "running", lastSeenAt: new Date().toISOString(),
  });
  await turnExecution({ ...context, sessionManager }).submitTurn(context.branch.id, context.node.id, "go");
  const completed = context.svc.getNode(context.node.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.runtimeAssistantMessageId, "durable-uuid");
  assert.equal(context.repo.getMessage(completed.assistantMessageRef).runtimeMessageId, "durable-uuid");
});
