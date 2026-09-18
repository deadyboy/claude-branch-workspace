import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.js";

export * from "./control-plane-client.js";
export * from "./server.js";
export * from "./tools.js";

export async function serveStdio(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is reserved for JSON-RPC.  Diagnostics belong on stderr.
  console.error("[cbw] agent-control MCP server listening on stdio");
}

const isMain = process.argv[1]
  ? resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
  : false;

if (isMain) {
  void serveStdio().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[cbw] agent-control MCP fatal: ${message}`);
    process.exitCode = 1;
  });
}

