import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, Repository, DomainService } from "../../../packages/domain/dist/index.js";
import { EventBus } from "../../../packages/event-protocol/dist/index.js";
import { buildApp } from "../../../apps/control-plane/dist/server.js";
import { FakeRuntime } from "../../../apps/control-plane/dist/fake-runtime.js";
import { SessionManager } from "../../../apps/control-plane/dist/session-manager.js";
import { ForkOrchestrator } from "../../../apps/control-plane/dist/fork-orchestrator.js";
import { AttentionRegistry } from "../../../apps/control-plane/dist/attention-registry.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { TOOL_NAMES } from "../dist/tools.js";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Keep the fake turn open long enough for MCP interrupt to reach the route. */
class InterruptibleFakeRuntime extends FakeRuntime {
  interrupted = new Set();

  async interrupt(sessionId) {
    this.interrupted.add(sessionId);
    await super.interrupt(sessionId);
  }

  wasInterrupted(sessionId) {
    return this.interrupted.has(sessionId);
  }

  async *sendMessage(sessionId, input) {
    await pause(75);
    if (this.interrupted.has(sessionId)) return;
    yield* super.sendMessage(sessionId, input);
  }
}

async function waitForResult(client, nodeId, expectedStatus = "completed") {
  let latest;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await client.callTool({ name: "get_turn_result", arguments: { nodeId } });
    assert.equal(response.isError, undefined, response.content?.[0]?.text);
    latest = JSON.parse(response.content[0].text);
    if (latest.status === expectedStatus) return latest;
    await pause(15);
  }
  assert.fail(`turn ${nodeId} did not reach ${expectedStatus}: ${JSON.stringify(latest)}`);
}

test("stdio MCP drives a real buildApp + SQLite + FakeRuntime control plane", async () => {
  const db = openDb(null);
  const repo = new Repository(db);
  const svc = new DomainService(repo);
  const bus = new EventBus();
  const adapter = new InterruptibleFakeRuntime();
  const sessionManager = new SessionManager(svc, adapter);
  const forkOrchestrator = new ForkOrchestrator(svc, sessionManager, adapter);
  const attention = new AttentionRegistry();
  const app = await buildApp({
    ctx: { db, svc, repo, bus, sessionManager, forkOrchestrator, attention, adapter },
    staticDir: null,
    logger: false,
  });
  mkdirSync("F:/CodexTemp",{recursive:true});
  const root=mkdtempSync("F:/CodexTemp/cbw-mcp-task-");
  writeFileSync(join(root,"result.txt"),"synthetic result");
  const project = svc.createProject({ name: "mcp-production-test", rootPath: root });
  const main = svc.createRootConversation({ projectId: project.id, rootBranchName: "Main" });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const port = new URL(address).port;
  const serverPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),
      CBW_CONTROL_PLANE_URL: `http://127.0.0.1:${port}`,
    },
  });
  const client = new Client({ name: "cbw-production-test", version: "0.1.0" }, { capabilities: {} });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name), TOOL_NAMES);

    const first = await client.callTool({ name: "send_message", arguments: { branchId: main.id, text: "main question" } });
    assert.equal(first.isError, undefined, first.content?.[0]?.text);
    const mainNodeId = JSON.parse(first.content[0].text).nodeId;
    const mainResult = await waitForResult(client, mainNodeId);
    assert.equal(mainResult.assistantContent, "echo for: main question");

    const created = await client.callTool({
      name: "create_branch_from_node",
      arguments: { projectId: project.id, nodeId: mainNodeId, displayName: "Child", workspaceMode: "shared" },
    });
    assert.equal(created.isError, undefined, created.content?.[0]?.text);
    const createdPayload = JSON.parse(created.content[0].text);
    const childId = createdPayload.branch.id;
    assert.equal(createdPayload.branch.displayName, "Child");
    assert.equal(createdPayload.snapshot.visibleMessageCount, 2);

    const branches = await client.callTool({ name: "list_branches", arguments: { projectId: project.id } });
    assert.equal(JSON.parse(branches.content[0].text).count, 2);
    const status = await client.callTool({ name: "get_branch_status", arguments: { branchId: main.id } });
    assert.equal(JSON.parse(status.content[0].text).branch.id, main.id);

    const execution = await client.callTool({ name: "query_execution_status", arguments: { branchId: main.id, nodeId: mainNodeId } });
    assert.equal(execution.isError, undefined, execution.content?.[0]?.text);
    assert.ok(JSON.parse(execution.content[0].text).nodeCount >= 1);

    const taskCreated = await client.callTool({name:"create_task",arguments:{projectId:project.id,branchId:childId,title:"tracked worker",instructions:"task result"}});
    assert.equal(taskCreated.isError,undefined,taskCreated.content?.[0]?.text);
    const taskId=JSON.parse(taskCreated.content[0].text).id;
    const taskRun=await client.callTool({name:"run_task",arguments:{taskId}});
    assert.equal(taskRun.isError,undefined,taskRun.content?.[0]?.text);
    const taskNodeId=JSON.parse(taskRun.content[0].text).nodeId;
    const taskResult=await client.callTool({name:"get_turn_result",arguments:{nodeId:taskNodeId,waitMs:2000}});
    assert.equal(JSON.parse(taskResult.content[0].text).status,"completed");
    const taskRead=await client.callTool({name:"get_task",arguments:{taskId}});
    const tracked=JSON.parse(taskRead.content[0].text);
    assert.equal(tracked.status,"completed");assert.equal(tracked.attempts[0].nodeId,taskNodeId);assert.ok(tracked.attempts[0].agentRunId);

    const declared = await client.callTool({name:"register_artifact",arguments:{branchId:childId,nodeId:taskNodeId,path:"result.txt"}});
    assert.equal(declared.isError,undefined,declared.content?.[0]?.text);
    const artifact=JSON.parse(declared.content[0].text);assert.equal(artifact.originTaskId,taskId);assert.equal(artifact.originNodeId,taskNodeId);assert.equal(artifact.originBranchId,childId);
    const invalidFile = await client.callTool({name:"register_artifact",arguments:{branchId:childId,nodeId:taskNodeId,path:"missing.txt"}});assert.equal(invalidFile.isError,true);

    const childMessage = await client.callTool({ name: "send_message", arguments: { branchId: childId, text: "child question" } });
    assert.equal(childMessage.isError, undefined, childMessage.content?.[0]?.text);
    const childNodeId = JSON.parse(childMessage.content[0].text).nodeId;
    await pause(10);
    const busyArchive = await client.callTool({ name: "archive_branch", arguments: { branchId: childId } });
    assert.equal(busyArchive.isError, true);
    assert.match(busyArchive.content[0].text, /HTTP 409/);
    const interrupted = await client.callTool({ name: "interrupt_branch", arguments: { branchId: childId } });
    assert.equal(interrupted.isError, undefined, interrupted.content?.[0]?.text);
    assert.equal(JSON.parse(interrupted.content[0].text).interrupted, true);
    const childResult = await waitForResult(client, childNodeId, "cancelled");
    assert.deepEqual(childResult.errors, ["turn cancelled"]);

    const archived = await client.callTool({ name: "archive_branch", arguments: { branchId: childId } });
    assert.equal(archived.isError, undefined, archived.content?.[0]?.text);
    assert.equal(JSON.parse(archived.content[0].text).branch.status, "archived");

    // The UI-facing REST read model sees the same inherited main result and
    // child-local user turn that the MCP tool chain just drove.
    const conversation = await app.inject({ method: "GET", url: `/api/branches/${childId}/conversation` });
    assert.equal(conversation.statusCode, 200);
    const items = conversation.json();
    assert.ok(items.some((item) => item.nodeId === mainNodeId && item.role === "assistant" && item.content === "echo for: main question"));
    assert.ok(items.some((item) => item.nodeId === childNodeId && item.role === "user" && item.content === "child question"));
  } finally {
    await client.close().catch(() => {});
    await app.close().catch(() => {});
    db.close();
    rmSync(root,{recursive:true,force:true});
  }
});
