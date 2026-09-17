import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, Repository, DomainService } from "@cbw/domain";
import { EventBus, TurnObserver } from "@cbw/event-protocol";
import { startBranch, runTurn } from "../dist/index.js";

// A deterministic fake adapter that emits a realistic stream-json-shaped event
// sequence for one turn: init, assistant(tool_use), user(tool_result), one
// subagent task_started/task_notification, assistant text, result.
function fakeAdapter({ seedName = "FAKE-EXT" } = {}) {
  const sessions = new Map();
  return {
    async startSession({ sessionId, cwd, workspaceMode, branchId }) {
      const external = `${seedName}-${sessions.size}`;
      sessions.set(sessionId, { external, started: true });
      return {
        externalSessionId: external,
        cwd,
        running: false,
        sessionKey: sessionId,
        runtimeVersion: "2.1.226-fake",
      };
    },
    async *sendMessage(sessionId) {
      const s = sessions.get(sessionId);
      if (!s) throw new Error("no session");
      yield { kind: "init", externalSessionId: s.external };
      yield { kind: "assistant", text: "Let me read a file" };
      yield { kind: "tool_use", name: "Read", input: { file_path: "a.ts" }, id: "tu_1" };
      yield { kind: "tool_result", toolUseId: "tu_1", isError: false };
      // subagent spawn
      yield { kind: "task", id: "tid_1", type: "task_started", taskId: "tid_1", subagentType: "Explore", description: "list nothing", status: "running" };
      yield { kind: "task", id: "tid_1", type: "task_notification", taskId: "tid_1", status: "completed", summary: "OK" };
      yield { kind: "assistant", text: "DONE" };
      yield { kind: "result", exitCode: 0 };
    },
  };
}

function setup() {
  const db = openDb(null);
  const repo = new Repository(db);
  const svc = new DomainService(repo);
  const bus = new EventBus();
  const events = [];
  bus.subscribe((ev) => events.push(ev));
  return { db, repo, svc, bus, events };
}

test("control plane: one branch turn with subagent + tool flows through observer to DB execution tree", async () => {
  const { svc, repo, bus, events } = setup();
  const adapter = fakeAdapter();
  const branch = svc.createRootConversation({ projectId: svc.createProject({ name: "p" }).id, rootBranchName: "Main" });
  const cwd = "C:\\fake\\cwd";

  const { sessionKey, session } = await startBranch(svc, bus, adapter, branch.id, cwd);
  assert.ok(sessionKey);
  assert.equal(session.externalSessionId, "FAKE-EXT-0");

  const node = svc.appendCompletedTurn({ branchId: branch.id, userContent: "run", assistantContent: null });
  const canonical = await runTurn(svc, bus, adapter, sessionKey, branch.id, node.id, sessionKey, "run a demo task");

  assert.ok(canonical.length > 0);

  // attribution: every bus event belongs to branch + node
  for (const ev of events) {
    assert.equal(ev.branchId, branch.id);
    assert.equal(ev.nodeId, node.id);
  }

  // lifecycle types present
  const types = events.map((e) => e.type);
  assert.ok(types.includes("session.started"));
  assert.ok(types.includes("tool.started"));
  assert.ok(types.includes("tool.completed"));
  assert.ok(types.includes("agent.started"));
  assert.ok(types.includes("agent.completed"));
  assert.ok(types.includes("session.stopped"));

  // persisted events include a tool.started with redacted payload
  const persisted = svc.listEventsByBranch(branch.id);
  assert.ok(persisted.length >= types.length, "events persisted like they were observed");
  const firstTool = persisted.find((e) => e.type === "tool.started");
  assert.equal(JSON.parse(firstTool.payloadJsonRedacted).tool, "Read");

  // execution tree: main -> Explore subagent
  const tree = svc.getExecutionTree(branch.id, node.id);
  assert.ok(tree.root, "execution tree has root");
  assert.equal(tree.root.agentRun.type, "main");
  assert.equal(tree.root.children.length, 1, "one subagent under main");
  assert.equal(tree.root.children[0].agentRun.name, "Explore");

  // transient AgentRuns are NOT branches: branch registry unchanged
  assert.equal(svc.listAgentRunsByBranch(branch.id).length, 2);
  assert.equal(repo.listBranchesByProject(svc.getBranch(branch.id).projectId).length, 1);
  assert.equal(svc.getBranch(branch.id).displayName, "Main");
});

test("control plane: task-first turn (no init) materializes main parent on demand and completes it", async () => {
  const { svc, bus, events } = setup();
  // A turn whose FIRST event is the subagent spawn (no prior init/main event):
  // the pseudo-parent main run must be created lazily so the FK resolves
  // (review BLOCKER #2), and closed at session.stopped (review MAJOR #3).
  const adapter = {
    async startSession({ sessionId }) {
      return { externalSessionId: `TF-${sessionId}`, cwd: "c", running: false, sessionKey: sessionId, runtimeVersion: "t" };
    },
    async *sendMessage() {
      yield { kind: "task", id: "t1", type: "task_started", taskId: "t1", subagentType: "Explore", description: "x", status: "running" };
      yield { kind: "task", id: "t1", type: "task_notification", taskId: "t1", status: "completed", summary: "OK" };
      yield { kind: "result", exitCode: 0 };
    },
  };
  const branch = svc.createRootConversation({ projectId: svc.createProject({ name: "p" }).id, rootBranchName: "Main" });
  const { sessionKey } = await startBranch(svc, bus, adapter, branch.id, "c");
  const node = svc.appendCompletedTurn({ branchId: branch.id, userContent: "go" });
  await runTurn(svc, bus, adapter, sessionKey, branch.id, node.id, sessionKey, "go");

  // no FK crash, and the tree is rooted at a completed main
  const tree = svc.getExecutionTree(branch.id, node.id);
  assert.ok(tree.root, "tree rooted");
  assert.equal(tree.root.agentRun.type, "main");
  assert.equal(tree.root.agentRun.status, "completed", "main run completed at session.stopped");
  assert.ok(tree.root.agentRun.endedAt, "main run has endedAt");
  assert.equal(tree.root.children.length, 1, "one subagent child");
  assert.equal(tree.root.children[0].agentRun.name, "Explore");
});

test("control plane: interrupt/error path marks agent.failed, not branch", async () => {
  const { svc, bus, events } = setup();
  // a fake that fails one tool
  const adapter = {
    async startSession({ sessionId, cwd, branchId }) {
      return { externalSessionId: "FAIL-EXT", cwd, running: false, sessionKey: sessionId };
    },
    async *sendMessage(sessionId) {
      yield { kind: "init", externalSessionId: "FAIL-EXT" };
      yield { kind: "tool_use", name: "Read", input: { file_path: "x" }, id: "tu_2" };
      yield { kind: "tool_result", toolUseId: "tu_2", isError: true };
      yield { kind: "result", exitCode: 1 };
    },
  };
  const branch = svc.createRootConversation({ projectId: svc.createProject({ name: "p" }).id, rootBranchName: "Main" });
  const { sessionKey } = await startBranch(svc, bus, adapter, branch.id, "C:\\x");
  const node = svc.appendCompletedTurn({ branchId: branch.id, userContent: "go" });
  await runTurn(svc, bus, adapter, sessionKey, branch.id, node.id, sessionKey, "go");

  const types = events.map((e) => e.type);
  assert.ok(types.includes("tool.failed"));
  assert.ok(types.includes("session.stopped"));
  assert.equal(svc.listAgentRunsByBranch(branch.id).length, 1, "only main run, no subagents");
  assert.equal(svc.getBranch(branch.id).status, "active", "branch not auto-archived on failure");
});
