import type {
  MessageInput,
  RuntimeCapabilities,
  RuntimeEvent,
  RuntimeSession,
  StartSessionInput,
} from "./types.js";

export type {
  MessageInput,
  RuntimeCapabilities,
  RuntimeEvent,
  RuntimeSession,
  StartSessionInput,
};

export interface ForkInput {
  newSessionId: string;
  cwd?: string;
  /**
   * Seed text for a reconstruction fork (ADR-006). When present the adapter must
   * feed THIS as the session's first prompt (instead of re-deriving it from the
   * snapshot), so the control plane can wrap the transcript in the
   * transcript-acknowledgement frame (gate 2: side-effect-free reconstruction —
   * old content is read-only prior context, never a command to re-run).
   */
  seedText?: string;
}

export interface HistoricalForkInput extends ForkInput {
  /** Transcript UUID at the inclusive boundary; distinct from API message IDs. */
  runtimeMessageId: string;
}

/**
 * RuntimeAdapter isolates the domain/UI from any specific Claude Code version
 * or implementation (ADR-005). Semantics per docs/03: persistent and transient
 * runtimes both hide behind this; the domain never depends on private CLI
 * structures.
 */
export interface RuntimeAdapter {
  getCapabilities(): Promise<RuntimeCapabilities>;

  startSession(input: StartSessionInput): Promise<RuntimeSession>;
  resumeSession(externalSessionId: string, cwd: string): Promise<RuntimeSession>;

  /** Send a turn; yields runtime events (assistant text, tool_use, subagents). */
  sendMessage(sessionId: string, input: MessageInput): AsyncIterable<RuntimeEvent>;

  /** Native fork-from-head: copies the session prefix to a new session. */
  forkFromHead(
    sessionId: string,
    input: ForkInput
  ): Promise<RuntimeSession>;

  /** Copy the complete native transcript prefix without running a model turn. */
  forkFromHistoricalNode?(
    sessionId: string,
    input: HistoricalForkInput
  ): Promise<RuntimeSession>;

  /** Reconstruct a new session from a persisted branch snapshot (ADR-006). */
  reconstructBranchFromHistory(snapshot: {
    visibleMessages: { role: "user" | "assistant"; content: string }[];
    projectInstructions?: string | null;
  }, input: ForkInput): Promise<RuntimeSession>;

  interrupt(sessionId: string): Promise<void>;
  terminate(sessionId: string): Promise<void>;

  subscribe(sessionId: string): AsyncIterable<RuntimeEvent>;
}
