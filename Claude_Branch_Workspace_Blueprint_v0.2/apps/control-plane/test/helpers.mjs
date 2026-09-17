// Shared S4 test helpers: an in-memory domain + a deterministic fake runtime
// adapter (structural RuntimeAdapter) with controllable sequencing primitives
// for concurrency/attention tests.
import { openDb, Repository, DomainService } from "@cbw/domain";
import { EventBus } from "@cbw/event-protocol";

export function setupService(dbPath = null) {
  const db = openDb(dbPath);
  const repo = new Repository(db);
  const svc = new DomainService(repo);
  const bus = new EventBus();
  const busEvents = [];
  bus.subscribe((ev) => busEvents.push(ev));
  return {
    db, repo, svc, bus, busEvents,
    close: () => db.close(),
  };
}

export function makeProject(svc, name = "p") {
  return svc.createProject({ name });
}

export function makeRoot(svc, projectId, name = "Main") {
  return svc.createRootConversation({ projectId, rootBranchName: name });
}

/**
 * A controllable fake adapter.
 *
 * `sendMessage(sessionId, {text})` yields a default benign turn:
 *   init -> message.assistant.completed(text) -> tool.started(Read) ->
 *   tool.completed -> result(exit 0)
 * and records `calls` for assertions.
 *
 * External sequencing: `signals` is a shared external queue of event batches.
 * When `signals` is non-empty, the generator pulls the NEXT batch from it
 * (awaiting `signals.push` when empty) instead of the default. This lets tests
 * drive interleaved concurrency (g11) and attention (g7) deterministically.
 */
export function fakeAdapter({ seedName = "FAKE-EXT" } = {}, signals = null) {
  const sessions = new Map();
  const calls = [];
  let n = 0;
  const adapt = {
    seedName,
    calls,
    async startSession({ sessionId, cwd, workspaceMode, branchId, projectInstructions }) {
      const external = `${seedName}-${n++}`;
      sessions.set(sessionId, { external, cwd, workspaceMode, branchId, projectInstructions });
      return {
        externalSessionId: external,
        cwd,
        running: false,
        sessionKey: sessionId,
        runtimeVersion: "1.0-fake",
      };
    },
    async resumeSession(externalSessionId, cwd) {
      const key = externalSessionId.startsWith(seedName) ? `resume-${externalSessionId}` : `r-${externalSessionId}`;
      sessions.set(key, { external: externalSessionId, cwd });
      return { externalSessionId, cwd, running: false, sessionKey: key, runtimeVersion: "1.0-fake" };
    },
    async forkFromHead(sessionId, input) {
      const s = sessions.get(sessionId);
      if (!s) throw new Error(`unknown parent session ${sessionId}`);
      const external = `${seedName}-fork-${n++}`;
      sessions.set(input.newSessionId, { external, cwd: s.cwd });
      calls.push(["forkFromHead", sessionId, input.newSessionId]);
      return { externalSessionId: external, cwd: s.cwd, running: false, sessionKey: input.newSessionId, runtimeVersion: "1.0-fake" };
    },
    async reconstructBranchFromHistory(snapshot, input) {
      const external = `${seedName}-recon-${n++}`;
      sessions.set(input.newSessionId, { external, cwd: input.cwd ?? "C:\\fake\\cwd" });
      // record seedText (the ack-wrapped transcript, gate 2) so tests can assert
      // the control plane actually handed the adapter the framed seed.
      calls.push(["reconstruct", snapshot, input.newSessionId, input.seedText]);
      return { externalSessionId: external, cwd: input.cwd ?? "C:\\fake\\cwd", running: false, sessionKey: input.newSessionId, runtimeVersion: "1.0-fake" };
    },
    async interrupt(sessionId) {
      adapt.interrupted = adapt.interrupted ?? [];
      const s = sessions.get(sessionId);
      if (!s) throw new Error(`interrupt unknown session ${sessionId}`);
      adapt.interrupted.push(sessionId);
    },
    async terminate(sessionId) {
      sessions.delete(sessionId);
    },
    async *subscribe() {},
    async getCapabilities() {
      return {
        persistentSessions: true, resume: true, forkFromHead: true, forkFromHistoricalNode: true,
        rewindConversation: false, nativeSubagents: true, lifecycleHooks: false, worktreeIsolation: false,
        interactivePermissions: false, eventStream: true,
      };
    },
    async *sendMessage(sessionId, input) {
      calls.push(["sendMessage", sessionId, input.text]);
      const s = sessions.get(sessionId);
      if (!s) throw new Error(`no session ${sessionId}`);
      if (signals) {
        for (;;) {
          if (signals.queue.length) {
            const batch = signals.queue.shift();
            if (batch === "DEFAULT") {
              for (const ev of defaultTurn(s, input.text)) yield ev;
              return;
            }
            if (Array.isArray(batch)) {
              for (const ev of batch) yield ev;
              return;
            }
            // a tuple [items, thenDefault] lets a test send a prefix then fall back
            if (Array.isArray(batch[0])) {
              for (const ev of batch[0]) yield ev;
              if (batch[1]) {
                for (const ev of defaultTurn(s, input.text)) yield ev;
              }
              return;
            }
            continue;
          }
          await new Promise((r) => {
            signals.waiters ??= [];
            signals.waiters.push(r);
          });
        }
      } else {
        for (const ev of defaultTurn(s, input.text)) yield ev;
      }
    },
  };
  return adapt;
}

export function defaultTurn(s, text) {
  const out = [
    { kind: "init", externalSessionId: s.external },
    { kind: "assistant", text: `echo for: ${text}` },
    { kind: "tool_use", name: "Read", input: { file_path: "a.ts" }, id: "tu_1" },
    { kind: "tool_result", toolUseId: "tu_1", isError: false },
    { kind: "result", exitCode: 0, stopReason: "end_turn" },
  ];
  return out;
}

export function attentionSignal(svc, projectId, branchId, text) {
  return {
    kind: "attention.required",
    attentionId: `atn-${Math.random().toString(36).slice(2, 8)}`,
    branchId,
    requestText: text,
    payload: { policy: "permission" },
  };
}
