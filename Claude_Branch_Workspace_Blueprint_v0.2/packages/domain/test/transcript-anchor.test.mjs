import { test } from "node:test";
import assert from "node:assert/strict";
import { newService } from "./helpers.mjs";

function fixture(t) {
  const context = newService();
  t.after(context.close);
  const project = context.svc.createProject({ name: "anchors" });
  const branch = context.svc.createRootConversation({ projectId: project.id });
  const node = context.svc.openTurn({ branchId: branch.id, userContent: "go" });
  return { ...context, project, branch, node };
}

test("completed transcript UUID persists on both node and assistant message, idempotently", t => {
  const { svc, repo, node } = fixture(t);
  const completed = svc.completeTurn(node.id, {
    status: "completed", assistantContent: "answer", runtimeAssistantMessageId: "transcript-uuid",
  });
  assert.equal(repo.getNode(node.id).runtimeAssistantMessageId, "transcript-uuid");
  assert.equal(repo.getMessage(completed.assistantMessageRef).runtimeMessageId, "transcript-uuid");
  const again = svc.completeTurn(node.id, {
    status: "completed", assistantContent: "replacement", runtimeAssistantMessageId: "replacement-uuid",
  });
  assert.equal(again.runtimeAssistantMessageId, "transcript-uuid");
  assert.equal(repo.getMessage(again.assistantMessageRef).visibleContent, "answer");
});

test("old callers without a transcript UUID persist null", t => {
  const { svc, repo, node } = fixture(t);
  const completed = svc.completeTurn(node.id, { status: "completed", assistantContent: "answer" });
  assert.equal(completed.runtimeAssistantMessageId, null);
  assert.equal(repo.getMessage(completed.assistantMessageRef).runtimeMessageId, null);
});

test("tool-only completion persists the node UUID without inventing visible text", t => {
  const { svc, repo, node, branch } = fixture(t);
  const completed = svc.completeTurn(node.id, { status: "completed", runtimeAssistantMessageId: "tool-only-uuid" });
  assert.equal(completed.runtimeAssistantMessageId, "tool-only-uuid");
  assert.equal(completed.assistantMessageRef, null);
  assert.equal(repo.listMessagesByBranch(branch.id).length, 1);
});

test("failed turns retain visible partial text but cannot expose transcript fork anchors", t => {
  const { svc, repo, node, project } = fixture(t);
  const failed = svc.completeTurn(node.id, {
    status: "failed", assistantContent: "partial", runtimeAssistantMessageId: "unsafe-uuid",
  });
  assert.equal(failed.runtimeAssistantMessageId, null);
  assert.equal(repo.getMessage(failed.assistantMessageRef).runtimeMessageId, null);
  assert.throws(() => svc.createBranchFromNode({ projectId: project.id, forkFromNodeId: node.id }), /only completed turns are forkable/);
});

test("node UUID, assistant message and terminal status roll back together", t => {
  const { svc, repo, node, branch } = fixture(t);
  const setNodeStatus = repo.setNodeStatus;
  repo.setNodeStatus = () => { throw new Error("write interrupted"); };
  assert.throws(() => svc.completeTurn(node.id, {
    status: "completed", assistantContent: "answer", runtimeAssistantMessageId: "rolled-back-uuid",
  }), /write interrupted/);
  repo.setNodeStatus = setNodeStatus;
  const pending = repo.getNode(node.id);
  assert.equal(pending.status, "pending");
  assert.equal(pending.runtimeAssistantMessageId, null);
  assert.equal(pending.assistantMessageRef, null);
  assert.equal(repo.listMessagesByBranch(branch.id).length, 1);
});
