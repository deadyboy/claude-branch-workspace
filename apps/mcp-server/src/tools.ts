import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ControlPlaneClient,
  ControlPlaneError,
  type AgentRunWire,
  type BranchWire,
  type ConversationNodeWire,
  type EffectiveConversationItemWire,
  type ExecutionNodeWire,
  type ExecutionTreeWire,
  type JsonRecord,
} from "./control-plane-client.js";

export const TOOL_NAMES = [
  "create_branch_from_node",
  "send_message",
  "list_branches",
  "get_branch_status",
  "interrupt_branch",
  "archive_branch",
  "query_execution_status",
  "get_turn_result",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export const MAX_BRANCHES = 200;
export const MAX_AGENT_RUNS = 200;
export const MAX_EXECUTION_NODES = 200;
export const MAX_EXECUTION_DEPTH = 16;
export const MAX_ASSISTANT_CHARS = 12_000;
export const MAX_ERROR_CHARS = 2_000;

const activeRunStatuses = new Set(["queued", "running", "waiting", "needs_attention"]);

// IDs are immutable UUIDs in the domain, but keeping the MCP boundary
// format-agnostic makes the adapter useful with test fixtures and future ID
// formats.  Path separators and URL delimiters are rejected before encoding.
const idSchema = z
  .string()
  .trim()
  .min(1, "must not be empty")
  .max(256, "must be at most 256 characters")
  .refine((value) => !/[\\/?#]/.test(value), "must not contain path or URL delimiters");

const textSchema = z
  .string()
  .max(100_000, "must be at most 100000 characters")
  .refine((value) => value.trim().length > 0, "must not be empty");

const cwdSchema = z
  .string()
  .trim()
  .min(1, "must not be empty")
  .max(4_096, "must be at most 4096 characters");

export const inputSchemas = {
  create_branch_from_node: {
    projectId: idSchema,
    nodeId: idSchema,
    displayName: z.string().trim().min(1).max(200).optional(),
    cwd: cwdSchema.optional(),
    workspaceMode: z.enum(["shared", "worktree"]).optional(),
  },
  send_message: {
    branchId: idSchema,
    text: textSchema,
    cwd: cwdSchema.optional(),
  },
  list_branches: {
    projectId: idSchema,
  },
  get_branch_status: {
    branchId: idSchema,
  },
  interrupt_branch: {
    branchId: idSchema,
  },
  archive_branch: {
    branchId: idSchema,
  },
  // A query can start from a branch and optional turn node, or from an
  // AgentRun id.  The latter is resolved through the existing run endpoint;
  // no run/session state is kept in this process.
  query_execution_status: {
    branchId: idSchema.optional(),
    nodeId: idSchema.optional(),
    agentRunId: idSchema.optional(),
  },
  get_turn_result: {
    nodeId: idSchema,
  },
} as const;

export interface CreateBranchFromNodeInput {
  projectId: string;
  nodeId: string;
  displayName?: string;
  cwd?: string;
  workspaceMode?: "shared" | "worktree";
}

export interface SendMessageInput {
  branchId: string;
  text: string;
  cwd?: string;
}

export interface QueryExecutionStatusInput {
  branchId?: string;
  nodeId?: string;
  agentRunId?: string;
}

export interface GetTurnResultInput {
  nodeId: string;
}

export interface ToolTextContent {
  type: "text";
  text: string;
}

export interface ToolResult {
  content: ToolTextContent[];
  isError?: boolean;
  [key: string]: unknown;
}

export interface ToolOperations {
  createBranchFromNode(input: CreateBranchFromNodeInput): Promise<JsonRecord>;
  sendMessage(input: SendMessageInput): Promise<JsonRecord>;
  listBranches(projectId: string): Promise<JsonRecord>;
  getBranchStatus(branchId: string): Promise<JsonRecord>;
  interruptBranch(branchId: string): Promise<JsonRecord>;
  archiveBranch(branchId: string): Promise<JsonRecord>;
  queryExecutionStatus(input: QueryExecutionStatusInput): Promise<JsonRecord>;
  getTurnResult(input: GetTurnResultInput): Promise<JsonRecord>;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function boundedText(value: unknown, max: number): { value: string | null; truncated: boolean } {
  if (typeof value !== "string") return { value: null, truncated: false };
  if (value.length <= max) return { value, truncated: false };
  return { value: `${value.slice(0, max)}…`, truncated: true };
}

function summarizeBranch(value: unknown): JsonRecord {
  const branch = isRecord(value) ? value : {};
  return {
    id: stringOrNull(branch.id),
    projectId: stringOrNull(branch.projectId),
    parentBranchId: stringOrNull(branch.parentBranchId),
    forkFromNodeId: stringOrNull(branch.forkFromNodeId),
    displayName: stringOrNull(branch.displayName),
    originStrategy: stringOrNull(branch.originStrategy),
    workspaceMode: stringOrNull(branch.workspaceMode),
    runtimeAdapter: stringOrNull(branch.runtimeAdapter),
    runtimeProfileId: stringOrNull(branch.runtimeProfileId),
    workspacePath: stringOrNull(branch.workspacePath),
    status: stringOrNull(branch.status),
    createdAt: stringOrNull(branch.createdAt),
    archivedAt: stringOrNull(branch.archivedAt),
  };
}

function summarizeAgentRun(value: unknown): JsonRecord {
  const run = isRecord(value) ? value : {};
  const taskSummary = boundedText(run.taskSummary, 500);
  return {
    id: stringOrNull(run.id),
    ownerBranchId: stringOrNull(run.ownerBranchId),
    ownerNodeId: stringOrNull(run.ownerNodeId),
    parentAgentRunId: stringOrNull(run.parentAgentRunId),
    type: stringOrNull(run.type),
    displayLabel: stringOrNull(run.displayLabel),
    name: stringOrNull(run.name),
    taskSummary: taskSummary.value,
    taskSummaryTruncated: taskSummary.truncated,
    status: stringOrNull(run.status),
    startedAt: stringOrNull(run.startedAt),
    endedAt: stringOrNull(run.endedAt),
  };
}

function summarizeSnapshot(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;
  const visibleMessages = Array.isArray(value.visibleMessages) ? value.visibleMessages : [];
  return {
    branchId: stringOrNull(value.branchId),
    forkFromNodeId: stringOrNull(value.forkFromNodeId),
    ancestorNodeCount: Array.isArray(value.ancestorNodeIds) ? value.ancestorNodeIds.length : 0,
    visibleMessageCount: visibleMessages.length,
    workspaceBinding: isRecord(value.workspaceBinding)
      ? {
          mode: stringOrNull(value.workspaceBinding.mode),
          path: stringOrNull(value.workspaceBinding.path),
        }
      : null,
    createdAt: stringOrNull(value.createdAt),
  };
}

function summarizeExecutionNode(
  value: unknown,
  state: { count: number; truncated: boolean },
  depth: number,
): JsonRecord | null {
  if (!isRecord(value) || !isRecord(value.agentRun)) return null;
  if (state.count >= MAX_EXECUTION_NODES || depth > MAX_EXECUTION_DEPTH) {
    state.truncated = true;
    return null;
  }
  state.count += 1;
  const rawChildren = Array.isArray(value.children) ? value.children : [];
  const children: JsonRecord[] = [];
  for (const child of rawChildren) {
    const summary = summarizeExecutionNode(child, state, depth + 1);
    if (summary) children.push(summary);
    if (state.truncated && state.count >= MAX_EXECUTION_NODES) break;
  }
  return { agentRun: summarizeAgentRun(value.agentRun), children };
}

function summarizeExecutionTree(value: unknown): JsonRecord {
  const tree = isRecord(value) ? value : {};
  const state = { count: 0, truncated: false };
  const root = summarizeExecutionNode(tree.root, state, 0);
  return {
    branchId: stringOrNull(tree.branchId),
    nodeId: stringOrNull(tree.nodeId),
    root,
    nodeCount: state.count,
    truncated: state.truncated,
  };
}

function requireRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new ControlPlaneError(`control-plane returned an invalid ${label}`, { code: "protocol" });
  return value;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new ControlPlaneError(`control-plane returned an invalid ${label}`, { code: "protocol" });
  return value;
}

function requireNonEmptyInput(input: QueryExecutionStatusInput): void {
  if (!input.branchId && !input.agentRunId) {
    throw new Error("branchId or agentRunId is required");
  }
  if (input.nodeId && !input.branchId && !input.agentRunId) {
    throw new Error("nodeId requires branchId or agentRunId");
  }
}

function summarizeError(status: string): string[] {
  if (status === "failed") return ["turn failed"];
  if (status === "cancelled") return ["turn cancelled"];
  return [];
}

export function createToolOperations(client: ControlPlaneClient): ToolOperations {
  return {
    async createBranchFromNode(input): Promise<JsonRecord> {
      const response = requireRecord(
        await client.createBranchFromNode({
          projectId: input.projectId,
          forkFromNodeId: input.nodeId,
          ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
          ...(input.workspaceMode === undefined ? {} : { workspaceMode: input.workspaceMode }),
        }),
        "branch creation response",
      );
      return {
        branch: summarizeBranch(response.branch),
        strategy: stringOrNull(response.strategy),
        snapshot: summarizeSnapshot(response.snapshot),
      };
    },

    async sendMessage(input): Promise<JsonRecord> {
      const response = requireRecord(await client.sendMessage(input.branchId, {
        text: input.text,
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      }), "send-message response");
      const nodeId = stringOrNull(response.nodeId);
      if (!nodeId) throw new ControlPlaneError("control-plane returned no nodeId", { code: "protocol" });
      return { branchId: input.branchId, nodeId, status: "accepted" };
    },

    async listBranches(projectId): Promise<JsonRecord> {
      const branches = requireArray(await client.listBranches(projectId), "branch list");
      const limited = branches.slice(0, MAX_BRANCHES).map(summarizeBranch);
      return {
        projectId,
        branches: limited,
        count: limited.length,
        truncated: branches.length > limited.length,
      };
    },

    async getBranchStatus(branchId): Promise<JsonRecord> {
      // Keep branch lookup first: the branch endpoint is authoritative for a
      // missing id; the agent-runs endpoint is a projection and may return [].
      const branch = await client.getBranch(branchId);
      const runs = requireArray(await client.listAgentRuns(branchId), "agent-run list");
      const limitedRuns = runs.slice(0, MAX_AGENT_RUNS).map(summarizeAgentRun);
      const activeRuns = runs.filter((run) => isRecord(run) && activeRunStatuses.has(String(run.status))).length;
      const status = stringOrNull(branch.status);
      const busy = branch.busy === true || activeRuns > 0;
      return {
        branch: summarizeBranch(branch),
        branchStatus: status,
        status: branch.queued === true ? "queued" : busy ? "running" : status,
        busy,
        activeRunCount: activeRuns,
        agentRuns: limitedRuns,
        agentRunsTruncated: runs.length > limitedRuns.length,
      };
    },

    async interruptBranch(branchId): Promise<JsonRecord> {
      const response = await client.interruptBranch(branchId);
      // The HTTP route returns its internal sessionKey.  It is intentionally
      // reduced to a boolean at this user-facing boundary.
      return {
        branchId,
        interrupted: isRecord(response) && (response.interrupted === true || typeof response.interrupted === "string"),
        status: "interrupt_requested",
      };
    },

    async archiveBranch(branchId): Promise<JsonRecord> {
      const branch = await client.archiveBranch(branchId);
      return { branch: summarizeBranch(branch), status: "archived" };
    },

    async queryExecutionStatus(input): Promise<JsonRecord> {
      requireNonEmptyInput(input);
      let branchId = input.branchId;
      let nodeId = input.nodeId;
      if (!branchId && input.agentRunId) {
        const run = await client.getAgentRun(input.agentRunId);
        branchId = run.ownerBranchId;
        nodeId = nodeId ?? run.ownerNodeId ?? undefined;
      }
      if (!branchId) throw new Error("agent run has no owner branch");
      const tree = await client.getExecutionTree(branchId, nodeId);
      return summarizeExecutionTree(tree);
    },

    async getTurnResult(input): Promise<JsonRecord> {
      const node = await client.getNode(input.nodeId);
      const branchId = stringOrNull(node.branchId);
      if (!branchId) throw new ControlPlaneError("control-plane node has no branchId", { code: "protocol" });
      const conversation = requireArray(await client.getConversation(branchId), "conversation");
      let assistant: EffectiveConversationItemWire | null = null;
      for (const item of conversation) {
        if (isRecord(item) && item.nodeId === input.nodeId && item.role === "assistant") {
          assistant = item as unknown as EffectiveConversationItemWire;
        }
      }
      const bounded = boundedText(assistant?.content, MAX_ASSISTANT_CHARS);
      const status = String(node.status);
      const errors = summarizeError(status);
      return {
        nodeId: input.nodeId,
        branchId,
        status,
        terminal: status !== "pending",
        assistantContent: bounded.value,
        assistantContentTruncated: bounded.truncated,
        errors,
        error: errors[0] ?? null,
      };
    },
  };
}

function jsonText(value: JsonRecord): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function formatToolError(error: unknown): ToolResult {
  if (error instanceof ControlPlaneError) {
    if (error.status !== null) {
      const detail = boundedText(error.message, MAX_ERROR_CHARS).value ?? "request failed";
      return {
        isError: true,
        content: [{ type: "text", text: `Control plane HTTP ${error.status}: ${detail}` }],
      };
    }
    const detail = boundedText(error.message, MAX_ERROR_CHARS).value ?? "request failed";
    return { isError: true, content: [{ type: "text", text: `Control plane ${error.code}: ${detail}` }] };
  }
  const detail = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text", text: `Invalid request: ${bounded(detail, MAX_ERROR_CHARS)}` }],
  };
}

function bounded(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

async function safeCall(operation: () => Promise<JsonRecord>): Promise<ToolResult> {
  try {
    return jsonText(await operation());
  } catch (error) {
    return formatToolError(error);
  }
}

/** Register exactly the eight public tools on an official MCP SDK server. */
export function registerControlPlaneTools(server: McpServer, client: ControlPlaneClient): ToolOperations {
  const operations = createToolOperations(client);

  server.registerTool(
    "create_branch_from_node",
    {
      title: "Create branch from conversation node",
      description: "Create a persistent branch frozen at a completed conversation node. Returns a bounded branch summary.",
      inputSchema: inputSchemas.create_branch_from_node,
    },
    async (input) => safeCall(() => operations.createBranchFromNode(input)),
  );

  server.registerTool(
    "send_message",
    {
      title: "Send message to branch",
      description: "Start one turn on a persistent branch. A busy branch returns a clear HTTP 409 error.",
      inputSchema: inputSchemas.send_message,
    },
    async (input) => safeCall(() => operations.sendMessage(input)),
  );

  server.registerTool(
    "list_branches",
    {
      title: "List project branches",
      description: "List bounded summaries of persistent branches in a project.",
      inputSchema: inputSchemas.list_branches,
    },
    async (input) => safeCall(() => operations.listBranches(input.projectId)),
  );

  server.registerTool(
    "get_branch_status",
    {
      title: "Get branch status",
      description: "Read one branch and its execution runs, with a synthesized busy/status view.",
      inputSchema: inputSchemas.get_branch_status,
    },
    async (input) => safeCall(() => operations.getBranchStatus(input.branchId)),
  );

  server.registerTool(
    "interrupt_branch",
    {
      title: "Interrupt branch turn",
      description: "Request cancellation of the active turn on one branch. An idle branch returns HTTP 409.",
      inputSchema: inputSchemas.interrupt_branch,
    },
    async (input) => safeCall(() => operations.interruptBranch(input.branchId)),
  );

  server.registerTool(
    "archive_branch",
    {
      title: "Archive branch",
      description: "Archive one persistent branch. A busy branch returns HTTP 409 and must be interrupted first.",
      inputSchema: inputSchemas.archive_branch,
    },
    async (input) => safeCall(() => operations.archiveBranch(input.branchId)),
  );

  server.registerTool(
    "query_execution_status",
    {
      title: "Query execution status",
      description: "Return a bounded execution-tree summary for a branch turn or AgentRun; event streams are never returned.",
      inputSchema: inputSchemas.query_execution_status,
    },
    async (input) => safeCall(() => operations.queryExecutionStatus(input)),
  );

  server.registerTool(
    "get_turn_result",
    {
      title: "Get turn result",
      description: "Read a node and its effective conversation to return bounded assistant output plus terminal status/errors.",
      inputSchema: inputSchemas.get_turn_result,
    },
    async (input) => safeCall(() => operations.getTurnResult(input)),
  );

  return operations;
}
