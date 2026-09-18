import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { TOOL_NAMES } from "../dist/tools.js";

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (error) { reject(error); }
    });
    request.on("error", reject);
  });
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

test("official MCP Client discovers and calls the stdio server", async () => {
  const controlPlane = createHttpServer(async (request, response) => {
    const body = request.method === "POST" ? await readJson(request) : {};
    if (request.method === "GET" && request.url === "/api/projects/project-1/branches") {
      return sendJson(response, 200, []);
    }
    if (request.method === "POST" && request.url === "/api/branches/branch-1/messages") {
      assert.deepEqual(body, { text: "hello" });
      return sendJson(response, 202, { nodeId: "node-1" });
    }
    return sendJson(response, 404, { error: "test route not found" });
  });
  await new Promise((resolve) => controlPlane.listen(0, "127.0.0.1", resolve));
  const address = controlPlane.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const serverPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),
      CBW_CONTROL_PLANE_URL: `http://127.0.0.1:${port}`,
    },
  });
  const client = new Client({ name: "cbw-mcp-test-client", version: "0.1.0" }, { capabilities: {} });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name), TOOL_NAMES);
    const result = await client.callTool({ name: "send_message", arguments: { branchId: "branch-1", text: "hello" } });
    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse(result.content[0].text), { branchId: "branch-1", nodeId: "node-1", status: "accepted" });
  } finally {
    await client.close().catch(() => {});
    await new Promise((resolve) => controlPlane.close(resolve));
  }
});

