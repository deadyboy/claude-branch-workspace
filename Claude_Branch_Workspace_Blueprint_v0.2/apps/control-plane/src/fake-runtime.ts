// Fake runtime adapter (CBW_FAKE_RUNTIME=1). A deterministic, hermetic
// RuntimeAdapter for the hermetic E2E (gate 10) and the S7 Playwright flow: it
// never spawns `claude`, always answers turns with benign tool/assistant
// sequences, and records its calls so tests can assert (e.g. exactly one seed
// per fork, gate 1).
//
// Optional CBW_FAKE_SCRIPT=<json file>: an array of turn scripts —
//   [{ branch: <branchDisplayName|"*">, text: <match|"*">, events: [...] | "DEFAULT" | ["DEFAULT"] }]
// lets the Playwright spec script the exact interaction (gate 10 golden path),
// including attention.required seeding (gate 7).

import type {
  ForkInput,
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeEvent,
  RuntimeSession,
  StartSessionInput,
} from "@cbw/runtime";

export interface FakeScriptTurn {
  text?: string;
  events: RuntimeEvent[] | "DEFAULT";
}

export interface FakeScript {
  turns: FakeScriptTurn[];
}

export function defaultTurnEvents(sessionKey: string, text: string): RuntimeEvent[] {
  return [
    { kind: "init", externalSessionId: `fake-${sessionKey}` },
    { kind: "assistant", text: `echo for: ${text}` },
    { kind: "tool_use", name: "Read", input: { file_path: "a.ts" }, id: "tu_f1" },
    { kind: "tool_result", toolUseId: "tu_f1", isError: false },
    { kind: "result", exitCode: 0, stopReason: "end_turn" },
  ];
}

export class FakeRuntime implements RuntimeAdapter {
  calls: string[] = [];
  private sessions = new Map<string, { external: string; cwd: string }>();
  private script: FakeScriptTurn[] = [];
  private consumed = new Set<number>();

  constructor(script?: FakeScript | null) {
    this.script = script?.turns ?? [];
  }

  async getCapabilities(): Promise<RuntimeCapabilities> {
    return {
      persistentSessions: true,
      resume: true,
      forkFromHead: true,
      forkFromHistoricalNode: true,
      rewindConversation: false,
      nativeSubagents: true,
      lifecycleHooks: false,
      worktreeIsolation: false,
      interactivePermissions: false,
      eventStream: true,
    };
  }

  async startSession(input: StartSessionInput): Promise<RuntimeSession> {
    this.calls.push(`startSession:${input.sessionId}`);
    const external = `fake-${input.sessionId}`;
    this.sessions.set(input.sessionId, { external, cwd: input.cwd });
    return { externalSessionId: external, cwd: input.cwd, running: false, sessionKey: input.sessionId, runtimeVersion: "fake" };
  }

  async resumeSession(externalSessionId: string, cwd: string): Promise<RuntimeSession> {
    this.calls.push(`resumeSession:${externalSessionId}`);
    const key = `resume-${externalSessionId}`;
    this.sessions.set(key, { external: externalSessionId, cwd });
    return { externalSessionId, cwd, running: false, sessionKey: key, runtimeVersion: "fake" };
  }

  async forkFromHead(sessionId: string, input: ForkInput): Promise<RuntimeSession> {
    this.calls.push(`forkFromHead:${input.newSessionId}`);
    const s = this.sessions.get(sessionId);
    const cwd = s?.cwd ?? "C:\\fake\\cwd";
    const external = `fake-fork-${input.newSessionId}`;
    this.sessions.set(input.newSessionId, { external, cwd });
    return { externalSessionId: external, cwd, running: false, sessionKey: input.newSessionId, runtimeVersion: "fake" };
  }

  async reconstructBranchFromHistory(
    _snapshot: { visibleMessages: { role: "user" | "assistant"; content: string }[]; projectInstructions?: string | null },
    input: ForkInput
  ): Promise<RuntimeSession> {
    this.calls.push(`reconstruct:${input.newSessionId}`);
    const cwd = input.cwd ?? "C:\\fake\\cwd";
    const external = `fake-recon-${input.newSessionId}`;
    this.sessions.set(input.newSessionId, { external, cwd });
    return { externalSessionId: external, cwd, running: false, sessionKey: input.newSessionId, runtimeVersion: "fake" };
  }

  async interrupt(sessionId: string): Promise<void> {
    this.calls.push(`interrupt:${sessionId}`);
  }

  async terminate(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  async *subscribe(): AsyncIterable<RuntimeEvent> {}

  async *sendMessage(sessionId: string, input: { text: string }): AsyncIterable<RuntimeEvent> {
    this.calls.push(`sendMessage:${sessionId}`);
    const chosen = this.peekScript(input.text);
    if (chosen.kind === "default") {
      for (const ev of defaultTurnEvents(sessionId, input.text)) yield ev;
      return;
    }
    for (const ev of chosen.events) yield ev;
  }

  private peekScript(text: string): SelectedTurn {
    const idx = this.script.findIndex(
      (t, i) => !this.consumed.has(i) && (t.text === undefined || t.text === "*" || t.text === text)
    );
    if (idx < 0) return { kind: "default" };
    this.consumed.add(idx);
    const ev = this.script[idx].events;
    if (ev === "DEFAULT") return { kind: "default" };
    return { kind: "script", events: ev };
  }
}

type SelectedTurn =
  | { kind: "default" }
  | { kind: "script"; events: RuntimeEvent[] };
