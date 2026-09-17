import { test } from "node:test";
import assert from "node:assert/strict";
import { newService } from "./helpers.mjs";

test("execution tree: AgentRun lifecycle is transient under a branch turn", () => {
  const { svc, close } = newService();
  const p = svc.createProject({ name: "p" });
  const main = svc.createRootConversation({ projectId: p.id, rootBranchName: "Main" });
  const node = svc.appendCompletedTurn({ branchId: main.id, userContent: "T1", assistantContent: "a" });

  // main run opens under the turn
  const mainRun = svc.openAgentRun({
    ownerBranchId: main.id,
    ownerNodeId: node.id,
    type: "main",
    name: "Main",
    taskSummary: "orchestrates",
  });
  assert.equal(mainRun.status, "running");
  assert.equal(mainRun.ownerBranchId, main.id);
  assert.equal(mainRun.ownerNodeId, node.id);

  const sub = svc.openAgentRun({
    ownerBranchId: main.id,
    ownerNodeId: node.id,
    parentAgentRunId: mainRun.id,
    type: "subagent",
    name: "explorer",
    taskSummary: "list nothing",
  });
  assert.equal(sub.parentAgentRunId, mainRun.id);

  const done = svc.completeAgentRun(mainRun.id, "completed");
  assert.equal(done.status, "completed");
  assert.ok(done.endedAt);

  // The execution tree shows the hierarchy rooted at the main run.
  const tree = svc.getExecutionTree(main.id, node.id);
  assert.deepEqual(tree.root.agentRun.id, mainRun.id);
  assert.equal(tree.root.children.length, 1);
  assert.deepEqual(tree.root.children[0].agentRun.id, sub.id);

  // AgentRuns are NOT branches — the branch registry is untouched.
  assert.equal(svc.listAgentRunsByBranch(main.id).length, 2);
  close();
});

test("events: redacted payload persisted and queryable by branch", () => {
  const { svc, close } = newService();
  const p = svc.createProject({ name: "p" });
  const main = svc.createRootConversation({ projectId: p.id });
  const node = svc.appendCompletedTurn({ branchId: main.id, userContent: "T1", assistantContent: "a" });

  svc.recordEvent({
    projectId: p.id,
    branchId: main.id,
    nodeId: node.id,
    type: "tool.started",
    status: "started",
    occurredAt: "2026-09-17T00:00:00.000Z",
    payloadJsonRedacted: JSON.stringify({ tool: "Read", file_path: "a.ts" }),
  });

  const events = svc.listEventsByBranch(main.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "tool.started");
  assert.equal(events[0].status, "started");
  assert.equal(events[0].nodeId, node.id);
  assert.equal(JSON.parse(events[0].payloadJsonRedacted).tool, "Read");
  close();
});
