import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ForkInput,
  MessageInput,
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeEvent,
  RuntimeSession,
  StartSessionInput,
} from "./adapter.js";

interface GatewayEnv {
  baseUrl: string;
  authToken: string;
}

// Live gateway observed in Phase 0 (15722), not settings' dead 15721.
// Overridable via CBW_BASE_URL / CBW_AUTH_TOKEN for environment portability.
function readGatewayEnv(): GatewayEnv {
  const settingsPath = join(homedir(), ".claude", "settings.json");
  let settingsEnv: Record<string, string> = {};
  try {
    settingsEnv = JSON.parse(readFileSync(settingsPath, "utf8")).env ?? {};
  } catch {
    // ignore missing/unreadable settings; rely on process.env
  }
  const baseUrl =
    process.env.CBW_BASE_URL ??
    settingsEnv.ANTHROPIC_BASE_URL?.replace("15721", "15722") ??
    "http://127.0.0.1:15722";
  const authToken = process.env.CBW_AUTH_TOKEN ?? settingsEnv.ANTHROPIC_AUTH_TOKEN ?? "";
  return { baseUrl, authToken };
}

interface ManagedSession {
  externalSessionId: string;
  cwd: string;
  running: boolean;
}

// Optional persistence hook to the control-plane's domain repository
// (constitution invariant 6: save the runtime session mapping). The runtime
// owns the mapping; the domain DB is the single fact source across restarts.
// Duck-typed so runtime does not depend on the domain package.
export interface RuntimePersistence {
  upsertRuntimeSession(s: {
    id: string;
    branchId: string;
    adapterType: string;
    externalSessionId: string | null;
    runtimeVersion: string | null;
    status: string;
    lastSeenAt: string;
    metadataJson: string;
  }): void;
  getRuntimeSessionByExternalId(
    externalId: string
  ): {
    id: string;
    branchId: string;
    externalSessionId: string | null;
    cwd?: string;
  } | null;
}

const CAPABILITIES: RuntimeCapabilities = {
  persistentSessions: true,
  resume: true,
  forkFromHead: true,
  forkFromHistoricalNode: true, // via reconstruction (ADR-006)
  rewindConversation: false, // not used for fork strategy
  nativeSubagents: true,
  lifecycleHooks: false, // empty payloads in this CLI version
  worktreeIsolation: true, // --worktree flag available
  interactivePermissions: false, // print-mode is non-interactive
  eventStream: true,
};

/**
 * Claude CLI adapter: drives real Claude Code sessions from a control plane.
 * Transport is child_process.spawn + `-p --verbose --output-format stream-json`
 * (ADR-007). Stdio: stdin closed (print mode is non-interactive), stdout parses
 * the JSON event stream, stderr carries diagnostics.
 */
export class ClaudeCliAdapter implements RuntimeAdapter {
  private env: NodeJS.ProcessEnv;
  private baseUrl: string;
  private authToken: string;
  private sessions = new Map<string, ManagedSession>();
  private counter = 0;

  constructor(
    private claudeBin = process.env.CBW_CLAUDE_BIN ?? "claude",
    private argvPrefix: string[] = [],
    private persistence?: RuntimePersistence,
    private turnTimeoutMs = 300_000
  ) {
    const gw = readGatewayEnv();
    this.baseUrl = gw.baseUrl;
    this.authToken = gw.authToken;
    this.env = {
      ...process.env,
      ANTHROPIC_BASE_URL: gw.baseUrl,
      ANTHROPIC_AUTH_TOKEN: gw.authToken,
    };
  }

  get gatewayAddress(): string {
    return this.baseUrl;
  }

  getCapabilities(): Promise<RuntimeCapabilities> {
    return Promise.resolve(CAPABILITIES);
  }

  // Per-branch settings: isolate auto-memory to <cwd>/.cbw/memory and default
  // to acceptEdits (non-interactive print mode). Returns the settings path.
  private writeSessionSettings(cwd: string, sessionId: string): string {
    const dir = join(cwd, ".cbw");
    const memoryDir = join(dir, "memory");
    mkdirSync(dir, { recursive: true });
    mkdirSync(memoryDir, { recursive: true });
    const settings = {
      autoMemoryMemoryDir: memoryDir,
      autoMemoryMemory: false,
      permissions: { defaultMode: "acceptEdits" },
    };
    const path = join(dir, `settings-${sessionId}.json`);
    writeFileSync(path, JSON.stringify(settings, null, 2));
    return path;
  }

  private newSessionId(prefix: string): string {
    return `${prefix}-${Date.now()}-${this.counter++}`;
  }

  private async spawnOnce(
    args: string[],
    cwd: string,
    sessionId: string
  ): Promise<{ child: ChildProcess; events: RuntimeEvent[]; stderr: string }> {
    const settingsPath = this.writeSessionSettings(cwd, sessionId);
    const fullArgs = ["--print", "--include-partial-messages", ...args, "--settings", settingsPath];
    const proc = spawn(this.claudeBin, [...this.argvPrefix, ...fullArgs], {
      cwd,
      env: this.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    const events: RuntimeEvent[] = [];
    let buf = "";
    let stderrBuf = "";
    const settledEvents: RuntimeEvent[] = [];
    const procRef = { current: proc };
    let errOutput = "";
    proc.stderr.on("data", (chunk: Buffer) => { stderrBuf += chunk.toString(); });
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else {
          settledEvents.push(...events);
          resolve();
        }
      };
      // A dead/hung gateway (or a child awaiting interactive input) must not
      // block the control plane forever: kill after turnTimeoutMs and surface
      // an error instead of an infinite await.
      const turnTimeoutMs = this.turnTimeoutMs;
      const timer = setTimeout(() => {
        if (proc.exitCode === null && !proc.killed) {
          try { proc.kill("SIGTERM"); } catch { /* already gone */ }
        }
        const reason = `turn timed out after ${turnTimeoutMs}ms (gateway unreachable or child hung)`;
        finish(new Error(reason));
      }, turnTimeoutMs);
      proc.stdout.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        let idx = buf.indexOf("\n");
        while (idx !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (line) {
            try {
              const ev = this.parseEvent(JSON.parse(line));
              if (Array.isArray(ev)) for (const e of ev) events.push(e);
              else if (ev) events.push(ev);
            } catch {
              // partial/malformed line: ignore
            }
          }
          idx = buf.indexOf("\n");
        }
      });
      proc.on("error", (err) => finish(err));
      proc.on("close", () => {
        if (buf.trim()) {
          try {
            const ev = this.parseEvent(JSON.parse(buf.trim()));
            if (Array.isArray(ev)) for (const e of ev) events.push(e);
            else if (ev) events.push(ev);
          } catch {
            // ignore trailing partial
          }
        }
        finish();
      });
    });
    void procRef;
    errOutput = stderrBuf;
    return { child: proc, events: settledEvents, stderr: errOutput };
  }

  async startSession(input: StartSessionInput): Promise<RuntimeSession> {
    // A zero-turn session is not resumable (probe: "No conversation found").
    // Start with a real turn so the session materializes a resumable handle,
    // and pin the external id to the control-plane UUID via --session-id.
    const startPrompt =
      input.projectInstructions ??
      "Session started. Await further instructions.";
    const child = await this.runTurn(
      input.cwd,
      input.sessionId,
      ["--session-id", input.sessionId],
      new Map(),
      startPrompt
    );
    const ext = child.initId;
    const s: ManagedSession = { externalSessionId: ext, cwd: input.cwd, running: false };
    this.sessions.set(input.sessionId, s);
    this.recordSession(input.sessionId, ext, input.cwd, child.version, input.branchId);
    return { externalSessionId: ext, cwd: input.cwd, running: false, runtimeVersion: child.version, sessionKey: input.sessionId };
  }

  // Persist the control-plane sessionKey -> external id mapping (non-secret).
  private recordSession(sessionKey: string, externalSessionId: string, cwd: string, runtimeVersion?: string, branchId?: string): void {
    if (!this.persistence) return;
    this.persistence.upsertRuntimeSession({
      id: sessionKey,
      branchId: branchId ?? sessionKey,
      adapterType: "claude-cli",
      externalSessionId,
      runtimeVersion: runtimeVersion ?? null,
      status: "running",
      lastSeenAt: new Date().toISOString(),
      metadataJson: "{}",
    });
  }

  async resumeSession(externalSessionId: string, cwd: string): Promise<RuntimeSession> {
    // Registration-only: a no-prompt `--resume` emits no init event (probe).
    // The actual --resume round-trip happens lazily on the first sendMessage,
    // which always carries a prompt and yields the (unchanged) external id.
    //
    // On restart the external id is read back from the persistence store (the
    // single fact source, constitution invariant 6): if this external id was
    // previously mapped, reuse that sessionKey so the branch identity survives
    // the control-plane restart. Otherwise create a fresh local key.
    let sessionKey = this.findMappedKey(externalSessionId);
    if (!sessionKey) sessionKey = this.newSessionId("resume");
    const s: ManagedSession = { externalSessionId, cwd, running: false };
    this.sessions.set(sessionKey, s);
    return { externalSessionId, cwd, running: false, sessionKey };
  }

  private findMappedKey(externalSessionId: string): string | null {
    // 1) already known in this adapter? 2) persisted mapping?
    for (const [k, v] of this.sessions) {
      if (v.externalSessionId === externalSessionId) return k;
    }
    if (this.persistence) {
      const rec = this.persistence.getRuntimeSessionByExternalId(externalSessionId);
      if (rec) return rec.id;
    }
    return null;
  }

  async *sendMessage(sessionId: string, input: MessageInput): AsyncIterable<RuntimeEvent> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`unknown session ${sessionId}`);
    const child = await this.runTurn(s.cwd, sessionId, ["--resume", s.externalSessionId], new Map(), input.text);
    for (const ev of child.events) yield ev;
  }

  async forkFromHead(sessionId: string, input: ForkInput): Promise<RuntimeSession> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`unknown session ${sessionId}`);
    // Native --fork-session REQUIRES a prompt to materialize the fork
    // (probe: no-prompt fork exits 1, "Provide a prompt to continue").
    const child = await this.runTurn(
      input.cwd ?? s.cwd,
      input.newSessionId,
      ["--resume", s.externalSessionId, "--fork-session", "--session-id", input.newSessionId],
      new Map(),
      "Branch forked from this point. Awaiting instructions."
    );
    const ext = child.initId;
    const ns: ManagedSession = { externalSessionId: ext, cwd: input.cwd ?? s.cwd, running: false };
    this.sessions.set(input.newSessionId, ns);
    this.recordSession(input.newSessionId, ext, input.cwd ?? s.cwd, child.version, input.newSessionId);
    return { externalSessionId: ext, cwd: input.cwd ?? s.cwd, running: false, runtimeVersion: child.version, sessionKey: input.newSessionId };
  }

  async reconstructBranchFromHistory(
    snapshot: { visibleMessages: { role: "user" | "assistant"; content: string }[]; projectInstructions?: string | null },
    input: ForkInput
  ): Promise<RuntimeSession> {
    const child = await this.runTurn(
      input.cwd ?? process.cwd(),
      input.newSessionId,
      ["--session-id", input.newSessionId],
      new Map(),
      snapshot.visibleMessages.map((m) => m.content).join("\n\n")
    );
    const ext = child.initId;
    const s: ManagedSession = { externalSessionId: ext, cwd: input.cwd ?? process.cwd(), running: false };
    this.sessions.set(input.newSessionId, s);
    this.recordSession(input.newSessionId, ext, input.cwd ?? process.cwd(), child.version, input.newSessionId);
    return { externalSessionId: ext, cwd: input.cwd ?? process.cwd(), running: false, runtimeVersion: child.version, sessionKey: input.newSessionId };
  }

  async interrupt(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    // Interrupt is handled by the caller via ChildProcess kill; sessions are
    // short-lived print-mode processes already completed. No-op to honor the
    // interface; see Phase 3 for long-lived process management.
  }

  async terminate(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  async *subscribe(sessionId: string): AsyncIterable<RuntimeEvent> {
    // Events are produced inline during sendMessage; subscribe is a passthrough
    // for the control-plane event bus (Phase 3). Yield nothing here.
    return;
  }

  private async runTurn(
    cwd: string,
    sessionKey: string,
    extraArgs: string[],
    envExtras: Map<string, string>,
    prompt?: string
  ): Promise<{ initId: string; version?: string; events: RuntimeEvent[] }> {
    const args = [...extraArgs, "--verbose", "--output-format", "stream-json"];
    if (prompt !== undefined) args.push(prompt);
    const { child, events, stderr } = await this.spawnOnce(args, cwd, sessionKey);
    void child;
    const init = events.find((e) => e.kind === "init") as { kind: "init"; externalSessionId: string; runtimeVersion?: string } | undefined;
    if (!init) throw new Error(`no init event; got ${events.map((e) => e.kind).join(",")}; stderr: ${stderr.slice(0, 500)}`);
    return { initId: init.externalSessionId, version: init.runtimeVersion, events };
  }

  private parseEvent(ev: any): RuntimeEvent[] | RuntimeEvent | null {
    if (!ev || typeof ev.type !== "string") return null;
    switch (ev.type) {
      case "system": {
        if (ev.subtype === "init") {
          return { kind: "init", externalSessionId: String(ev.session_id), runtimeVersion: ev.runtime_version };
        }
        if (ev.subtype === "thinking_tokens") return null; // hidden chain-of-thought: never surface
        // system:task_* / background_tasks_changed belong to the execution tree.
        if (typeof ev.subtype === "string" && ev.subtype.startsWith("task_")) {
          return {
            kind: "task",
            id: String(ev.uuid ?? ev.subtask_uuid ?? ev.session_id ?? ev.subtype),
            type: ev.subtype,
            status: typeof ev.status === "string" ? ev.status : undefined,
          };
        }
        if (ev.subtype === "background_tasks_changed") {
          return { kind: "task", id: String(ev.uuid ?? "bg"), type: "background_tasks_changed" };
        }
        return null; // other system noise (hook_*, status) not a domain event
      }
      case "assistant": {
        // Real stream-json nests blocks in message.content[]; tools are blocks
        // of type "tool_use". We surface one assistant text event and let any
        // tool_use blocks become their own events.
        const content = Array.isArray(ev.message?.content) ? ev.message.content : [];
        const text = content.filter((c: any) => c.type === "text" || !c.type).map((c: any) => c.text ?? "").join("");
        const out: RuntimeEvent[] = [];
        if (text) out.push({ kind: "assistant", text });
        for (const b of content) {
          if (b?.type === "tool_use") {
            out.push({ kind: "tool_use", name: String(b.name ?? ""), input: b.input, id: b.id });
          }
        }
        return out.length ? out : null;
      }
      case "user": {
        // tool_result blocks live in user messages' content.
        const content = Array.isArray(ev.message?.content) ? ev.message.content : [];
        const results = content.filter((c: any) => c?.type === "tool_result");
        if (!results.length) return null;
        return { kind: "tool_result", toolUseId: results[0].tool_use_id, isError: !!results[0].is_error };
      }
      case "result":
        return { kind: "result", stopReason: ev.stop_reason, exitCode: ev.is_error ? 1 : 0 };
      default:
        // Unknown/unhandled event types are dropped, not misattributed to the
        // execution tree as tasks.
        return null;
    }
  }
}
