// Phase 4 hard gate 2: reconstruction is SIDE-EFFECT-FREE. reconstructBranchFromHistory
// must never replay old tool side effects / Bash / file writes / MCP.
//
// Two layers of the assertion (reviewer R1):
//   (a) snapshot purity — the frozen snapshot passed to the adapter is content-only
//       (messages with role+content; no tool/branch/session instructions that could
//       be interpreted).
//   (b) adapter-level — feeding a transcript yields ZERO tool_use events. We pin the
//       transcript-ack frame (TRANSCRIPT_ACK) and assert via the fake adapter that a
//       reconstruction call flags zero tool/Bash/MCP invocations; the real adapter's
//       reconstruction path is pinned to that same content-only join (no grep-able
//       tool section) by a source/CLI assertion in the runtime package.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeProject, makeRoot, setupService, fakeAdapter } from "./helpers.mjs";
import { SessionManager } from "../dist/session-manager.js";
import { ForkOrchestrator, TRANSCRIPT_ACK } from "../dist/fork-orchestrator.js";
import { runTurnOnce } from "../dist/turn-runner.js";

function turn(svc, sessionManager, adapter, bus, branchId, text) {
  return sessionManager.resolveSession({ branchId, cwd: "C:\\fake\\cwd" }).then(async (st) => {
    const node = svc.openTurn({ branchId, userContent: text });
    const { result } = await runTurnOnce({ svc, bus, adapter, sessionKey: st.sessionKey, branchId, nodeId: node.id, runtimeSessionId: st.sessionKey, text });
    svc.completeTurn(node.id, { assistantContent: result.assistantContent, status: result.status === "completed" ? "completed" : (result.status === "cancelled" ? "failed" : "failed") });
    sessionManager.release(branchId);
    return { node, result };
  });
}

test("g2: reconstruction snapshot is content-only and pure (no tool/instructions executable)", async () => {
  const { db, svc, repo, bus, close } = setupService();
  const adapter = fakeAdapter();
  const sm = new SessionManager(svc, adapter);
  const fo = new ForkOrchestrator(svc, sm, adapter);

  const p = makeProject(svc);
  const main = makeRoot(svc, p.id, "Main");
  await turn(svc, sm, adapter, bus, main.id, "T1");
  const t2 = await turn(svc, sm, adapter, bus, main.id, "T2");

  // Make the fork point historical. A persisted idle parent mapping is eligible
  // for a native head fork, so a later parent turn is the concrete discriminator
  // for reconstruction here.
  await turn(svc, sm, adapter, bus, main.id, "T3");
  sm.release(main.id);
  const created = await fo.createFork({ projectId: p.id, forkFromNodeId: t2.node.id, displayName: "Child" });
  assert.equal(created.strategy, "replay_reconstruction");

  const snap = created.snapshot;
  assert.ok(snap, "snapshot captured at creation");
  assert.ok(snap.visibleMessages.every((m) =>
    (m.role === "user" || m.role === "assistant") && typeof m.content === "string"),
    "snapshot contains only role+content, no executable/path/token instructions");
  assert.ok(snap.projectInstructions === null, "no fabricated instructions");
  assert.deepEqual(
    snap.visibleMessages.map((m) => `${m.role}:${m.content}`),
    ["user:T1", "assistant:echo for: T1", "user:T2", "assistant:echo for: T2"],
    "content-only messages (user+assistant) oldest first, exactly through the fork point",
  );

  // The fork's seed is wrapped in the transcript-ack frame (R1) so no content is
  // a command to re-run.
  const reconCall = adapter.calls.find((c) => c[0] === "reconstruct");
  assert.ok(reconCall, "reconstruction happened");
  close();
});

test("g2: fake flags ZERO tool/bash/mcp invocations during reconstruction", async () => {
  const { db, svc, bus, close } = setupService();
  const adapter = fakeAdapter();
  const sm = new SessionManager(svc, adapter);
  const fo = new ForkOrchestrator(svc, sm, adapter);

  const p = makeProject(svc);
  const main = makeRoot(svc, p.id, "Main");
  await turn(svc, sm, adapter, bus, main.id, "T1");
  const t2 = await turn(svc, sm, adapter, bus, main.id, "T2");

  // Make t2 historical before measuring the fork window.
  await turn(svc, sm, adapter, bus, main.id, "T3");

  // Baseline: the three parent turns each ran a sendMessage; count them so the
  // fork window below is measured in isolation (g2 zero-side-effect).
  const baselineSend = adapter.calls.filter((c) => c[0] === "sendMessage").length;
  const callBase = adapter.calls.length;

  sm.release(main.id);
  await fo.createFork({ projectId: p.id, forkFromNodeId: t2.node.id, displayName: "Child" });

  // A pure reconstruction: exactly ONE reconstruct call, NO sendMessage and NO
  // forkFromHead — an old turn being replayed would run sendMessage; a native
  // head fork would run forkFromHead. Neither happens here (parent turns'
  // sendMessage calls already counted in `baselineSend`).
  const forkWindow = adapter.calls.slice(callBase);
  const sendCalls = forkWindow.filter((c) => c[0] === "sendMessage");
  const forkCalls = forkWindow.filter((c) => c[0] === "forkFromHead");
  const reconCalls = forkWindow.filter((c) => c[0] === "reconstruct");
  assert.equal(sendCalls.length, 0, "no sendMessage ran old tools during reconstruction");
  assert.equal(forkCalls.length, 0, "no forkFromHead replayed parent state");
  assert.equal(reconCalls.length, 1, "exactly one reconstruction seed");
  // The frozen snapshot is CONTENT-ONLY — no tool-input/Go/Bash blocks.
  const transcript = JSON.stringify(reconCalls[0][1]);
  assert.ok(!/tool_use|Bash|Write|Edit|Read/.test(transcript), "reconstruct seeded with content only");
  // Gate 2 (reviewer BLOCKER fox): the ack-wrapped transcript is ACTUALLY passed
  // to the adapter as seedText — not a dead variable. The seed must (a) contain
  // the whole prior transcript and (b) be framed so old content is read-only
  // prior context, never a command to re-run.
  const seedText = typeof reconCalls[0][3] === "string" ? reconCalls[0][3] : "";
  assert.ok(seedText.length > 0, "reconstruction passes a real seedText to the adapter");
  assert.ok(seedText.includes(TRANSCRIPT_ACK), "seed carries the transcript-ack frame");
  assert.ok(seedText.includes("T1"), "seed includes the prior transcript (user side)");
  assert.ok(seedText.includes("echo for: T1"), "seed includes the prior transcript (assistant side)");
  assert.match(seedText, /Do NOT re-run any command/, "ack instruction is present in the seed");
  close();
});

test("g2: TRANSCRIPT_ACK wraps the seed so old content is never a command", () => {
  assert.ok(TRANSCRIPT_ACK.includes("Do NOT re-run any command, tool, or file write"));
  assert.ok(TRANSCRIPT_ACK.includes("read-only context"));
});

test("g2 (adapter structural): real adapter reconstruction joins only message content (no tool section)", async () => {
  // Hermetic: pin the real adapter's reconstruction path to a content-only join.
  // We cannot spawn `claude` in a hermetic test; instead assert the CLI contract:
  // reconstructBranchFromHistory builds a FRESH session (--session-id, no
  // --resume/--fork-session) and joins ONLY snapshot.visibleMessages[].content —
  // there is no translated tool/write instruction to re-execute anywhere in the
  // reconstruction function body.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(
    new URL("../../../packages/runtime/dist/claude-cli-adapter.js", import.meta.url),
    "utf8",
  );

  const fn = src.slice(src.indexOf("async reconstructBranchFromHistory"));
  const fnBody = fn.slice(0, fn.indexOf("async interrupt"));
  assert.ok(fnBody.length > 0, "reconstruction function body found");
  assert.ok(fnBody.includes("visibleMessages") && fnBody.includes("seedText"),
    "reconstruction consumes only the supplied visible transcript and seed frame");
  // It builds a fresh session: --session-id, no resume/fork replay args.
  assert.ok(fnBody.includes("--session-id"), "reconstruction uses a fresh --session-id");
  assert.ok(!fnBody.includes("--resume"), "reconstruction does NOT --resume the parent session");
  assert.ok(!fnBody.includes("--fork-session"), "reconstruction does NOT fork later state into the child");
  // Content-only join means there is no place a tool/write instruction is parsed
  // and turned into an executable action inside reconstruction.
  assert.ok(!/tool_use|"kind":\s*"tool_use"|buildRedactedPayload.*tool/.test(fnBody),
    "reconstruction body parses no tool_use instruction to re-execute");
});
