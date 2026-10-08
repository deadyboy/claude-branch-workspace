/**
 * Small HTTP client for the existing control plane.
 *
 * This package deliberately contains no database, runtime adapter, or
 * SessionManager.  It is a process boundary: every operation goes through
 * the loopback REST API owned by apps/control-plane.
 */

export const DEFAULT_CONTROL_PLANE_URL = "http://127.0.0.1:15723";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

export type FetchLike = typeof fetch;

export interface ControlPlaneClientOptions {
  baseUrl?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export interface ControlPlaneRequestOptions {
  method?: "GET" | "POST" | "PATCH";
  body?: unknown;
  /** Per-request override, used for the control plane's eager fork seed. */
  timeoutMs?: number;
}

export class ControlPlaneError extends Error {
  readonly code: "http" | "network" | "timeout" | "protocol" | "configuration";
  readonly status: number | null;
  readonly details: string | null;

  constructor(
    message: string,
    opts: {
      code: ControlPlaneError["code"];
      status?: number | null;
      details?: string | null;
    },
  ) {
    super(message);
    this.name = "ControlPlaneError";
    this.code = opts.code;
    this.status = opts.status ?? null;
    this.details = opts.details ?? null;
  }
}

export interface BranchWire {
  busy?: boolean;
  queued?: boolean;
  id: string;
  projectId: string;
  parentBranchId: string | null;
  forkFromNodeId: string | null;
  displayName: string | null;
  originStrategy: string;
  workspaceMode: string;
  runtimeAdapter: string;
  runtimeSessionId: string | null;
  runtimeProfileId: string | null;
  workspacePath: string | null;
  status: string;
  createdAt: string;
  archivedAt: string | null;
}

export interface AgentRunWire {
  id: string;
  ownerBranchId: string;
  ownerNodeId: string | null;
  parentAgentRunId: string | null;
  runtimeAgentId: string | null;
  type: string;
  displayLabel: string | null;
  name: string | null;
  taskSummary: string | null;
  status: string;
  startedAt: string;
  endedAt: string | null;
}

export interface ConversationNodeWire {
  id: string;
  projectId: string;
  branchId: string;
  parentNodeId: string | null;
  localTurnIndex: number;
  userMessageRef: string;
  assistantMessageRef: string | null;
  runtimeUserMessageId: string | null;
  runtimeAssistantMessageId: string | null;
  status: "pending" | "completed" | "failed" | "cancelled" | string;
  createdAt: string;
  completedAt: string | null;
  [key: string]: unknown;
}

export interface EffectiveConversationItemWire {
  role: "user" | "assistant" | string;
  content: string;
  nodeId: string;
  origin: "inherited" | "local" | string;
  seq: number;
}

export interface ExecutionTreeWire {
  sessionKey?: string;
  branchId?: string;
  nodeId?: string | null;
  root?: ExecutionNodeWire | null;
  [key: string]: unknown;
}

export interface ExecutionNodeWire {
  agentRun: AgentRunWire;
  children?: ExecutionNodeWire[];
  [key: string]: unknown;
}

export type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1") return true;
  const octets = host.split(".");
  if (octets.length !== 4 || octets.some((part) => !/^\d+$/.test(part))) return false;
  const numbers = octets.map(Number);
  return numbers[0] === 127 && numbers.every((part) => part >= 0 && part <= 255);
}

/**
 * Validate the only kind of endpoint this package is allowed to call.
 * The MCP server is local stdio, and the control plane is deliberately
 * restricted to an HTTP loopback origin with no credentials or URL prefix.
 */
export function validateControlPlaneUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ControlPlaneError("control-plane URL is not a valid URL", { code: "configuration" });
  }
  if (
    url.protocol !== "http:" ||
    !isLoopbackHostname(url.hostname) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new ControlPlaneError(
      "control-plane URL must be an HTTP loopback URL without credentials, query, hash, or path",
      { code: "configuration" },
    );
  }
  return url;
}

function bounded(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function errorText(body: unknown, fallback: string): string {
  if (isRecord(body) && typeof body.error === "string" && body.error.trim()) {
    return bounded(body.error.trim(), 500);
  }
  if (typeof body === "string" && body.trim()) return bounded(body.trim(), 500);
  return fallback;
}

function inferredErrorStatus(status: number, body: unknown): number {
  if (status !== 200 || !isRecord(body) || typeof body.error !== "string") return status;
  // A few Phase 4 handlers returned `{error}` with the default 200 status.
  // Interpret those legacy responses using the documented error taxonomy so
  // MCP callers still receive a useful 404/409 result.
  if (/not found|no execution tree/i.test(body.error)) return 404;
  if (/busy|idle/i.test(body.error)) return 409;
  return 400;
}

async function readResponseBody(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  // A streamed read keeps a malformed or unexpectedly large control-plane
  // response from being buffered without a bound.  The fallback is for
  // minimal Response-like test doubles that do not expose a body reader.
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new ControlPlaneError("control-plane response exceeded the safety limit", { code: "protocol" });
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let rejectAbort: ((reason?: unknown) => void) | null = null;
  const abortPromise = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = (): void => {
    void reader.cancel();
    rejectAbort?.(new Error("response read aborted"));
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal.aborted) onAbort();
    for (;;) {
      const chunk = await Promise.race([reader.read(), abortPromise]);
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ControlPlaneError("control-plane response exceeded the safety limit", { code: "protocol" });
      }
      chunks.push(chunk.value);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export class ControlPlaneClient {
  readonly baseUrl: string;
  private readonly base: URL;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: ControlPlaneClientOptions | string = {}) {
    const config: ControlPlaneClientOptions = typeof options === "string" ? { baseUrl: options } : options;
    const raw = config.baseUrl ?? process.env.CBW_CONTROL_PLANE_URL ?? DEFAULT_CONTROL_PLANE_URL;
    this.base = validateControlPlaneUrl(raw);
    this.baseUrl = this.base.toString().replace(/\/$/, "");
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120_000) {
      throw new ControlPlaneError("control-plane timeout must be an integer from 1 to 120000 ms", {
        code: "configuration",
      });
    }
  }

  private endpoint(path: string): string {
    const normalized = path.startsWith("/") ? path.slice(1) : path;
    return new URL(normalized, `${this.baseUrl}/`).toString();
  }

  async request<T>(path: string, options: ControlPlaneRequestOptions = {}): Promise<T> {
    const method = options.method ?? "GET";
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 900_000) {
      throw new ControlPlaneError("control-plane request timeout must be an integer from 1 to 900000 ms", {
        code: "configuration",
      });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const init: RequestInit = {
      method,
      headers: { accept: "application/json" },
      signal: controller.signal,
      redirect: "error",
    };
    if (options.body !== undefined) {
      init.headers = { accept: "application/json", "content-type": "application/json" };
      init.body = JSON.stringify(options.body);
    }

    try {
      const response = await this.fetchImpl(this.endpoint(path), init);
      let rawBody = "";
      try {
        rawBody = await readResponseBody(response, MAX_RESPONSE_BYTES, controller.signal);
      } catch (error) {
        if (error instanceof ControlPlaneError) {
          if (error.status === null) {
            throw new ControlPlaneError(error.message, { code: error.code, status: response.status, details: error.details });
          }
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        const timedOut = controller.signal.aborted;
        throw new ControlPlaneError(
          timedOut ? "control-plane request timed out" : "control-plane response could not be read",
          { code: timedOut ? "timeout" : "protocol", status: response.status, details: bounded(message, 300) },
        );
      }

      let body: unknown = null;
      if (rawBody.trim()) {
        try {
          body = JSON.parse(rawBody) as unknown;
        } catch {
          if (!response.ok) {
            throw new ControlPlaneError(
              errorText(rawBody, `control-plane returned HTTP ${response.status}`),
              { code: "http", status: response.status },
            );
          }
          throw new ControlPlaneError("control-plane returned invalid JSON", {
            code: "protocol",
            status: response.status,
          });
        }
      }

      const status = inferredErrorStatus(response.status, body);
      if (!response.ok || (isRecord(body) && typeof body.error === "string")) {
        throw new ControlPlaneError(errorText(body, `control-plane returned HTTP ${response.status}`), {
          code: "http",
          status,
        });
      }
      return body as T;
    } catch (error) {
      if (error instanceof ControlPlaneError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const timedOut = controller.signal.aborted;
      throw new ControlPlaneError(
        timedOut ? "control-plane request timed out" : "control-plane request could not be reached",
        { code: timedOut ? "timeout" : "network", details: bounded(message, 300) },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  getBranch(branchId: string): Promise<BranchWire> {
    return this.request<BranchWire>(`/api/branches/${encodeURIComponent(branchId)}`);
  }

  listBranches(projectId: string): Promise<BranchWire[]> {
    return this.request<BranchWire[]>(`/api/projects/${encodeURIComponent(projectId)}/branches`);
  }

  createBranchFromNode(body: {
    projectId: string;
    forkFromNodeId: string;
    displayName?: string;
    cwd?: string;
    workspaceMode?: "shared" | "worktree";
  }): Promise<JsonRecord> {
    // ForkOrchestrator eagerly seeds/reconstructs the child before returning.
    // A real Claude runtime can legitimately take several minutes here; this
    // is deliberately a long timeout and is not a retry (fork is a mutation).
    return this.request<JsonRecord>("/api/branches", {
      method: "POST",
      body,
      timeoutMs: 650_000,
    });
  }

  sendMessage(branchId: string, body: { text: string; cwd?: string }): Promise<{ nodeId: string }> {
    return this.request<{ nodeId: string }>(`/api/branches/${encodeURIComponent(branchId)}/messages`, {
      method: "POST",
      body,
    });
  }

  createTask(body: { projectId: string; branchId: string; title: string; instructions: string; role?: string }): Promise<JsonRecord> {
    return this.request<JsonRecord>("/api/tasks", { method: "POST", body });
  }
  runTask(taskId: string): Promise<JsonRecord> {
    return this.request<JsonRecord>(`/api/tasks/${encodeURIComponent(taskId)}/run`, { method: "POST", body: {} });
  }
  getTask(taskId: string): Promise<JsonRecord> {
    return this.request<JsonRecord>(`/api/tasks/${encodeURIComponent(taskId)}`);
  }

  registerArtifact(branchId: string, body: { nodeId: string; path: string; kind?: "file" | "report"; summary?: string }): Promise<JsonRecord> {
    return this.request<JsonRecord>(`/api/branches/${encodeURIComponent(branchId)}/artifacts`, { method: "POST", body });
  }

  listAgentRuns(branchId: string): Promise<AgentRunWire[]> {
    return this.request<AgentRunWire[]>(`/api/branches/${encodeURIComponent(branchId)}/agent-runs`);
  }

  interruptBranch(branchId: string): Promise<JsonRecord> {
    return this.request<JsonRecord>(`/api/branches/${encodeURIComponent(branchId)}/interrupt`, {
      method: "POST",
      body: {},
    });
  }

  archiveBranch(branchId: string): Promise<BranchWire> {
    return this.request<BranchWire>(`/api/branches/${encodeURIComponent(branchId)}/archive`, {
      method: "POST",
      body: {},
    });
  }

  getAgentRun(agentRunId: string): Promise<AgentRunWire> {
    return this.request<AgentRunWire>(`/api/agent-runs/${encodeURIComponent(agentRunId)}`);
  }

  getExecutionTree(branchId: string, nodeId?: string): Promise<ExecutionTreeWire> {
    const suffix = nodeId ? `?nodeId=${encodeURIComponent(nodeId)}` : "";
    return this.request<ExecutionTreeWire>(`/api/branches/${encodeURIComponent(branchId)}/execution-tree${suffix}`);
  }

  getNode(nodeId: string): Promise<ConversationNodeWire> {
    return this.request<ConversationNodeWire>(`/api/nodes/${encodeURIComponent(nodeId)}`);
  }

  getConversation(branchId: string): Promise<EffectiveConversationItemWire[]> {
    return this.request<EffectiveConversationItemWire[]>(`/api/branches/${encodeURIComponent(branchId)}/conversation`);
  }
}
