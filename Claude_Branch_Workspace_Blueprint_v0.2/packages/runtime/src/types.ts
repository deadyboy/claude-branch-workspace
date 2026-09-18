// Runtime adapter types (docs/03_RUNTIME_ADAPTER.md).

export type RuntimeCapabilities = {
  persistentSessions: boolean;
  resume: boolean;
  forkFromHead: boolean;
  forkFromHistoricalNode: boolean;
  rewindConversation: boolean;
  nativeSubagents: boolean;
  lifecycleHooks: boolean;
  worktreeIsolation: boolean;
  interactivePermissions: boolean;
  eventStream: boolean;
};

export interface StartSessionInput {
  sessionId: string; // control-plane-chosen UUID (immutable identity)
  cwd: string; // branch workspace (shared) or worktree path
  projectInstructions?: string | null;
  workspaceMode: "shared" | "worktree";
  permissionMode?: string; // e.g. "acceptEdits"
  branchId?: string; // optional owning branch identity; mappings are persisted by SessionManager
}

export interface MessageInput {
  text: string;
}

export type RuntimeEvent =
  | { kind: "init"; externalSessionId: string; runtimeVersion?: string }
  | { kind: "assistant"; text: string; messageId?: string }
  | { kind: "tool_use"; name: string; input: unknown; id?: string }
  | { kind: "tool_result"; toolUseId?: string; isError?: boolean }
  | { kind: "subagent_start"; name?: string; id?: string }
  | { kind: "subagent_stop"; id?: string }
  | { kind: "attention"; summary?: string }
  | {
      kind: "task";
      id: string;
      type: string; // task_started | task_updated | task_notification | ...
      status?: string;
      // Phase 3: fields from the real stream-json task_* surface (live-probed
      // 2026-09-17): task_id, tool_use_id, subagent_type, description, summary.
      taskId?: string;
      toolUseId?: string;
      subagentType?: string;
      description?: string;
      summary?: string;
    }
  | { kind: "result"; stopReason?: string; exitCode?: number; sequence?: unknown }
  | { kind: "error"; message: string };

export interface RuntimeSession {
  externalSessionId: string;
  cwd: string;
  running: boolean;
  runtimeVersion?: string;
  /** Control-plane-local registry key for sendMessage/fork/terminate. */
  sessionKey: string;
}
