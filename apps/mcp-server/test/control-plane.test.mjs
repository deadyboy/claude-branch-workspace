import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ControlPlaneClient,
  ControlPlaneError,
  validateControlPlaneUrl,
} from "../dist/control-plane-client.js";
import { createToolOperations, MAX_ASSISTANT_CHARS } from "../dist/tools.js";

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test('branch status retains queued and warmup claims before AgentRuns exist', async () => {
  for (const queued of [true, false]) {
    const { fetchImpl } = fakeHttp([
      { method: 'GET', path: '/api/branches/b', response: { id: 'b', status: 'active', busy: true, queued } },
      { method: 'GET', path: '/api/branches/b/agent-runs', response: [] },
    ]);
    const status = await createToolOperations(new ControlPlaneClient({ fetchImpl })).getBranchStatus('b');
    assert.equal(status.busy, true);
    assert.equal(status.status, queued ? 'queued' : 'running');
    assert.equal(status.activeRunCount, 0);
  }
});

function fakeHttp(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    const call = {
      method: init.method ?? "GET",
      path: `${parsed.pathname}${parsed.search}`,
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const route = routes.find((candidate) =>
      candidate.method === call.method && candidate.path === call.path,
    );
    if (!route) return jsonResponse({ error: `unexpected ${call.method} ${call.path}` }, 500);
    return typeof route.response === "function" ? route.response(call) : jsonResponse(route.response, route.status ?? 200);
  };
  return { fetchImpl, calls };
}

test("loopback URL validation rejects remote, credentialed, and path URLs", () => {
  assert.equal(validateControlPlaneUrl("http://127.0.0.1:15723").hostname, "127.0.0.1");
  assert.equal(validateControlPlaneUrl("http://localhost:15723").hostname, "localhost");
  assert.throws(() => validateControlPlaneUrl("https://127.0.0.1:15723"), /HTTP loopback/);
  assert.throws(() => validateControlPlaneUrl("http://192.168.1.20:15723"), /HTTP loopback/);
  assert.throws(() => validateControlPlaneUrl("http://user:pass@127.0.0.1:15723"), /HTTP loopback/);
  assert.throws(() => validateControlPlaneUrl("http://127.0.0.1:15723/api"), /HTTP loopback/);
  assert.equal(new ControlPlaneClient("http://127.0.0.1:15723").baseUrl, "http://127.0.0.1:15723");
});

test("request timeout remains active while a response body is still streaming", async () => {
  const response = {
    status: 200,
    ok: true,
    body: {
      getReader() {
        return {
          read: () => new Promise(() => {}),
          cancel: async () => {},
        };
      },
    },
  };
  const client = new ControlPlaneClient({
    baseUrl: "http://127.0.0.1:15723",
    timeoutMs: 20,
    fetchImpl: async () => response,
  });
  await assert.rejects(
    () => client.getBranch("slow-body"),
    (error) => error instanceof ControlPlaneError && error.code === "timeout" && error.message.includes("timed out"),
  );
});

test("all eight operations map to the existing control-plane HTTP contract", async () => {
  const branch = {
    id: "branch-1",
    projectId: "project-1",
    parentBranchId: null,
    forkFromNodeId: "node-0",
    displayName: "Child",
    originStrategy: "replay_reconstruction",
    workspaceMode: "shared",
    runtimeAdapter: "claude-cli",
    runtimeProfileId: null,
    workspacePath: null,
    status: "active",
    createdAt: "2026-09-18T00:00:00.000Z",
    archivedAt: null,
  };
  const run = {
    id: "run-1",
    ownerBranchId: "branch-1",
    ownerNodeId: "node-1",
    parentAgentRunId: null,
    runtimeAgentId: null,
    type: "main",
    displayLabel: null,
    name: "Main",
    taskSummary: "work",
    status: "running",
    startedAt: "2026-09-18T00:00:00.000Z",
    endedAt: null,
  };
  const tree = { sessionKey: "cp-secret-internal", branchId: "branch-1", nodeId: "node-1", root: { agentRun: run, children: [] } };
  const node = {
    id: "node-1",
    projectId: "project-1",
    branchId: "branch-1",
    parentNodeId: null,
    localTurnIndex: 0,
    userMessageRef: "message-1",
    assistantMessageRef: "message-2",
    runtimeUserMessageId: null,
    runtimeAssistantMessageId: null,
    status: "completed",
    createdAt: "2026-09-18T00:00:00.000Z",
    completedAt: "2026-09-18T00:01:00.000Z",
  };
  const { fetchImpl, calls } = fakeHttp([
    { method: "POST", path: "/api/branches", status: 201, response: { branch, strategy: "replay_reconstruction", snapshot: { branchId: "branch-1", forkFromNodeId: "node-0", ancestorNodeIds: ["node-0"], visibleMessages: [{ role: "user", content: "private" }], createdAt: "2026-09-18T00:00:00.000Z" }, sessionKey: "cp-secret-internal" } },
    { method: "POST", path: "/api/branches/branch-1/messages", status: 202, response: { nodeId: "node-1" } },
    { method: "GET", path: "/api/projects/project-1/branches", response: [branch] },
    { method: "GET", path: "/api/branches/branch-1", response: branch },
    { method: "GET", path: "/api/branches/branch-1/agent-runs", response: [run] },
    { method: "POST", path: "/api/branches/branch-1/interrupt", status: 202, response: { interrupted: "cp-secret-internal" } },
    { method: "POST", path: "/api/branches/branch-1/archive", response: { ...branch, status: "archived", archivedAt: "2026-09-18T00:02:00.000Z" } },
    { method: "GET", path: "/api/branches/branch-1/execution-tree?nodeId=node-1", response: tree },
    { method: "GET", path: "/api/nodes/node-1", response: node },
    { method: "GET", path: "/api/branches/branch-1/conversation", response: [
      { role: "user", content: "hello", nodeId: "node-1", origin: "local", seq: 1 },
      { role: "assistant", content: "done", nodeId: "node-1", origin: "local", seq: 2 },
    ] },
  ]);
  const client = new ControlPlaneClient({ baseUrl: "http://127.0.0.1:15723", fetchImpl });
  const operations = createToolOperations(client);

  const created = await operations.createBranchFromNode({ projectId: "project-1", nodeId: "node-0", displayName: "Child", cwd: "C:\\work", workspaceMode: "worktree" });
  assert.equal(created.branch.id, "branch-1");
  assert.equal(created.snapshot.visibleMessageCount, 1);
  assert.equal(created.sessionKey, undefined, "internal session key is not exposed");
  assert.deepEqual(await operations.sendMessage({ branchId: "branch-1", text: "hello" }), { branchId: "branch-1", nodeId: "node-1", status: "accepted" });
  assert.equal((await operations.listBranches("project-1")).branches.length, 1);
  const status = await operations.getBranchStatus("branch-1");
  assert.equal(status.busy, true);
  assert.equal(status.status, "running");
  assert.deepEqual(await operations.interruptBranch("branch-1"), { branchId: "branch-1", interrupted: true, status: "interrupt_requested" });
  assert.equal((await operations.archiveBranch("branch-1")).status, "archived");
  const execution = await operations.queryExecutionStatus({ branchId: "branch-1", nodeId: "node-1" });
  assert.equal(execution.nodeCount, 1);
  assert.equal(execution.root.agentRun.id, "run-1");
  assert.equal(execution.sessionKey, undefined, "internal execution session key is not exposed");
  assert.deepEqual(await operations.getTurnResult({ nodeId: "node-1" }), {
    nodeId: "node-1",
    branchId: "branch-1",
    status: "completed",
    terminal: true,
    assistantContent: "done",
    assistantContentTruncated: false,
    errors: [],
    error: null,
  });

  assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), [
    "POST /api/branches",
    "POST /api/branches/branch-1/messages",
    "GET /api/projects/project-1/branches",
    "GET /api/branches/branch-1",
    "GET /api/branches/branch-1/agent-runs",
    "POST /api/branches/branch-1/interrupt",
    "POST /api/branches/branch-1/archive",
    "GET /api/branches/branch-1/execution-tree?nodeId=node-1",
    "GET /api/nodes/node-1",
    "GET /api/branches/branch-1/conversation",
  ]);
  assert.deepEqual(calls[0].body, {
    projectId: "project-1",
    forkFromNodeId: "node-0",
    displayName: "Child",
    cwd: "C:\\work",
    workspaceMode: "worktree",
  });
});

test("HTTP 400/404/409 errors stay clear and legacy {error} 200 responses are classified", async () => {
  for (const [status, expected] of [[400, 400], [404, 404], [409, 409]]) {
    const client = new ControlPlaneClient({
      baseUrl: "http://127.0.0.1:15723",
      fetchImpl: async () => jsonResponse({ error: "branch is busy; interrupt before archiving" }, status),
    });
    await assert.rejects(
      () => client.archiveBranch("branch-1"),
      (error) => error instanceof ControlPlaneError && error.status === expected && error.message.includes("branch is busy"),
    );
  }
  const legacy = new ControlPlaneClient({
    baseUrl: "http://127.0.0.1:15723",
    fetchImpl: async () => jsonResponse({ error: "branch not found" }, 200),
  });
  await assert.rejects(
    () => legacy.getBranch("missing"),
    (error) => error instanceof ControlPlaneError && error.status === 404,
  );
});

test("turn and execution summaries remain bounded", async () => {
  const longText = "x".repeat(MAX_ASSISTANT_CHARS + 100);
  const hugeChildren = Array.from({ length: 250 }, (_, index) => ({
    agentRun: { id: `run-${index}`, ownerBranchId: "branch-1", ownerNodeId: "node-1", status: "completed" },
    children: [],
  }));
  const node = { id: "node-1", branchId: "branch-1", status: "failed" };
  const { fetchImpl } = fakeHttp([
    { method: "GET", path: "/api/nodes/node-1", response: node },
    { method: "GET", path: "/api/branches/branch-1/conversation", response: [{ role: "assistant", content: longText, nodeId: "node-1", origin: "local", seq: 1 }] },
    { method: "GET", path: "/api/branches/branch-1/execution-tree", response: { branchId: "branch-1", nodeId: null, root: { agentRun: { id: "root", ownerBranchId: "branch-1", status: "running" }, children: hugeChildren } } },
  ]);
  const operations = createToolOperations(new ControlPlaneClient({ fetchImpl }));
  const result = await operations.getTurnResult({ nodeId: "node-1" });
  assert.equal(result.assistantContent.length, MAX_ASSISTANT_CHARS + 1, "bounded text includes truncation marker");
  assert.equal(result.assistantContentTruncated, true);
  assert.deepEqual(result.errors, ["turn failed"]);
  const tree = await operations.queryExecutionStatus({ branchId: "branch-1" });
  assert.equal(tree.nodeCount, 200);
  assert.equal(tree.truncated, true);
});
