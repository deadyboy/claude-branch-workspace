import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, Repository, DomainService } from "@cbw/domain";
import { EventBus } from "@cbw/event-protocol";
import { startBranch, runTurn } from "../dist/index.js";
import { AttentionRegistry } from "../dist/attention-registry.js";
import { SessionManager } from "../dist/session-manager.js";
import { runTurnOnce } from "../dist/turn-runner.js";

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

// Explicit lifecycle helper (gate 5): openTurn -> runTurnOnce -> completeTurn.
async function runExplicit(svc, bus, adapter, sm, branchId, text) {
  const st = await sm.resolveSession({ branchId, cwd: "C:\\fake\\cwd" });
  const node = svc.openTurn({ branchId, userContent: text });
  const { result } = await runTurnOnce({ svc, bus, adapter, sessionKey: st.sessionKey, branchId, nodeId: node.id, runtimeSessionId: st.sessionKey, text });
  svc.completeTurn(node.id, { assistantContent: result.assistantContent, status: result.status === "completed" ? "completed" : "failed" });
  sm.release(branchId);
  return { node, result, sessionKey: st.sessionKey };
}

test("control plane: explicit lifecycle — one branch turn with subagent + tool flows through observer to DB execution tree", async () => {
  const { svc, repo, bus, events, db } = setup();
  const adapter = fakeAdapter();
  const sm = new SessionManager(svc, adapter);
  const branch = svc.createRootConversation({ projectId: svc.createProject({ name: "p" }).id, rootBranchName: "Main" });

  const { node } = await runExplicit(svc, bus, adapter, sm, branch.id, "run a demo task");
  assert.equal(svc.getNode(node.id).status, "completed");

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
  assert.equal(svc.listAgentRunsByBranch(branch.id).filter((r) => r.type === "main").length, 1);
  assert.equal(svc.listAgentRunsByBranch(branch.id).length >= 1, true);
  assert.equal(repo.listBranchesByProject(svc.getBranch(branch.id).projectId).length, 1);
  assert.equal(svc.getBranch(branch.id).displayName, "Main");
  db.close();
});

test("control plane: explicit lifecycle — task-first turn (no init) materializes main parent and completes it", async () => {
  const { svc, bus, events, db } = setup();
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
  const sm = new SessionManager(svc, adapter);
  const branch = svc.createRootConversation({ projectId: svc.createProject({ name: "p" }).id, rootBranchName: "Main" });
  const { node } = await runExplicit(svc, bus, adapter, sm, branch.id, "go");

  // no FK crash, and the tree is rooted at a completed main
  const tree = svc.getExecutionTree(branch.id, node.id);
  assert.ok(tree.root, "tree rooted");
  assert.equal(tree.root.agentRun.type, "main");
  assert.equal(tree.root.agentRun.status, "completed", "main run completed at session.stopped");
  assert.ok(tree.root.agentRun.endedAt, "main run has endedAt");
  assert.equal(tree.root.children.length, 1, "one subagent child");
  assert.equal(tree.root.children[0].agentRun.name, "Explore");
  db.close();
});

test("control plane: explicit lifecycle — interrupt/error path marks agent.failed, not branch", async () => {
  const { svc, bus, events, db } = setup();
  const adapter = {
    async startSession({ sessionId, cwd, branchId }) {
      return { externalSessionId: "FAIL-EXT", cwd, running: false, sessionKey: sessionId };
    },
    async *sendMessage() {
      yield { kind: "init", externalSessionId: "FAIL-EXT" };
      yield { kind: "tool_use", name: "Read", input: { file_path: "x" }, id: "tu_2" };
      yield { kind: "tool_result", toolUseId: "tu_2", isError: true };
      yield { kind: "result", exitCode: 1 };
    },
  };
  const sm = new SessionManager(svc, adapter);
  const branch = svc.createRootConversation({ projectId: svc.createProject({ name: "p" }).id, rootBranchName: "Main" });
  const { node } = await runExplicit(svc, bus, adapter, sm, branch.id, "go");

  const types = events.map((e) => e.type);
  assert.ok(types.includes("tool.failed"));
  assert.ok(types.includes("session.stopped"));
  assert.equal(svc.getBranch(branch.id).status, "active", "branch not auto-archived on failure");
  assert.equal(svc.getNode(node.id).status, "failed", "turn failed, not cancelled/archived");
  db.close();
});

test("g7: attention raw event over runTurnOnce seeds an AttentionRegistry card via the event bus", async () => {
  const { svc, bus, events, db } = setup();
  const adapter = {
    async startSession({ sessionId }) {
      return { externalSessionId: `ATN-${sessionId}`, cwd: "c", running: false, sessionKey: sessionId, runtimeVersion: "a" };
    },
    async *sendMessage() {
      yield { kind: "init", externalSessionId: "ATN-1" };
      yield { kind: "assistant", text: "planning" };
      yield { kind: "attention", summary: "Approve running npm test" };
      yield { kind: "result", exitCode: 0 };
    },
  };
  const sm = new SessionManager(svc, adapter);
  // production wiring (index.ts): a bus subscriber seeds the registry
  const attention = new AttentionRegistry();
  bus.subscribe((ev) => {
    if (ev.type === "permission.requested" || ev.type === "attention.required") attention.seedFromEvent(ev);
  });
  const branch = svc.createRootConversation({ projectId: svc.createProject({ name: "p" }).id, rootBranchName: "Main" });

  const { node } = await runExplicit(svc, bus, adapter, sm, branch.id, "plan the change");

  // the canonical attention.required event was published on the bus...
  const attnEv = events.find((e) => e.type === "attention.required");
  assert.ok(attnEv, "attention.required published");
  // ...it carried the redacted summary (not the raw request), attributed to branch+node
  assert.equal(attnEv.branchId, branch.id);
  assert.equal(attnEv.nodeId, node.id);
  assert.equal(attnEv.payload.summary, "Approve running npm test");
  // ...and the registry now has a pending card driven by that same subscription
  const cards = attention.list("pending");
  assert.equal(cards.length, 1);
  assert.equal(cards[0].type, "question");
  assert.equal(cards[0].branchId, branch.id);
  assert.equal(cards[0].projectId, svc.getBranch(branch.id).projectId);
  db.close();
});
