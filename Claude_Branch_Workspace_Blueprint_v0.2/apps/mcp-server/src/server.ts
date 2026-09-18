import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ControlPlaneClient,
  type ControlPlaneClientOptions,
} from "./control-plane-client.js";
import { registerControlPlaneTools, type ToolOperations } from "./tools.js";

export interface CreateMcpServerOptions extends ControlPlaneClientOptions {
  client?: ControlPlaneClient;
}

export interface McpServerBundle {
  server: McpServer;
  client: ControlPlaneClient;
  operations: ToolOperations;
}

/**
 * Build one independent MCP server instance.  The instance owns only MCP
 * registration and an HTTP client; control-plane state remains in the
 * already-running control-plane process.
 */
export function createMcpServer(options: CreateMcpServerOptions = {}): McpServer {
  const client = options.client ?? new ControlPlaneClient(options);
  const server = new McpServer({ name: "cbw-agent-control", version: "0.1.0" });
  registerControlPlaneTools(server, client);
  return server;
}

/** Test and embedding helper that exposes the registered operation facade. */
export function createMcpServerBundle(options: CreateMcpServerOptions = {}): McpServerBundle {
  const client = options.client ?? new ControlPlaneClient(options);
  const server = new McpServer({ name: "cbw-agent-control", version: "0.1.0" });
  const operations = registerControlPlaneTools(server, client);
  return { server, client, operations };
}

