import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ClaudeCliAdapter } from "../dist/index.js";

// Phase 2 acceptance gate: a REAL Claude runtime session end-to-end. Requires
// the desktop gateway to be live. RUN ONLY when CBW_LIVE=1 (opt-in), so the
// default test suite stays hermetic/offline and never spends live turns.
const live = process.env.CBW_LIVE === "1";

test("phase2: real runtime fork-fidelity across restart", { skip: !live }, async () => {
  const adapter = new ClaudeCliAdapter();
  const caps = await adapter.getCapabilities();
  assert.ok(caps.persistentSessions, "persistent sessions supported");

  const cwd = process.cwd(); // shared workspace for the test

  // 1. Main starts a real session (fresh control-plane UUID per run — the CLI
  //    rejects a --session-id that is already "in use" in its own store).
  const mainKey = randomUUID();
  const main = await adapter.startSession({
    sessionId: mainKey,
    cwd,
    projectInstructions: "You are in a fork-fidelity demo. Answer tersely.",
  });
  assert.ok(main.externalSessionId, "main session has external id");

  // 2. Main completes 4 turns.
  const t1 = [];
  for await (const ev of adapter.sendMessage(mainKey, { text: "Turn 1: reply with the single word ONE" })) t1.push(ev);
  const text1 = t1.filter((e) => e.kind === "assistant").map((e) => e.text).join("");
  assert.match(text1, /ONE/, "turn 1 answered ONE");

  for await (const _ of adapter.sendMessage(mainKey, { text: "Turn 2: reply with the single word TWO" })) {}
  for await (const _ of adapter.sendMessage(mainKey, { text: "Turn 3: reply with the single word THREE" })) {}
  for await (const _ of adapter.sendMessage(mainKey, { text: "Turn 4: reply with the single word FOUR" })) {}

  // 3. Fork-from-head at head (native). New child C.
  const childKey = randomUUID();
  const child = await adapter.forkFromHead(mainKey, { newSessionId: childKey, cwd });
  assert.ok(child.externalSessionId !== main.externalSessionId, "child has new external id");

  // 4. Main continues turn 5 — must NOT see child's content, stay independent.
  const t5 = [];
  for await (const ev of adapter.sendMessage(mainKey, { text: "Turn 5: reply with the single word FIVE" })) t5.push(ev);
  const text5 = t5.filter((e) => e.kind === "assistant").map((e) => e.text).join("");
  assert.match(text5, /FIVE/, "main turn 5 answered FIVE");

  // 5. Child continues independently.
  const c2 = [];
  for await (const ev of adapter.sendMessage(childKey, { text: "Child turn 2: reply with the single word CHILD" })) c2.push(ev);
  const textC = c2.filter((e) => e.kind === "assistant").map((e) => e.text).join("");
  assert.match(textC, /CHILD/, "child continued independently");

  // 6. Child creates grandchild (fork-from-head again).
  const gKey = randomUUID();
  const grand = await adapter.forkFromHead(childKey, { newSessionId: gKey, cwd });
  assert.ok(grand.externalSessionId !== child.externalSessionId, "grandchild new external id");

  // 7. Control-plane restart: simulate by creating a FRESH adapter instance
  //    (new in-memory session registry) and resuming via persisted external id.
  const adapter2 = new ClaudeCliAdapter();
  const resumedMain = await adapter2.resumeSession(main.externalSessionId, cwd);
  assert.deepEqual(resumedMain.externalSessionId, main.externalSessionId, "main resumes on same external id");
  const resumedChild = await adapter2.resumeSession(child.externalSessionId, cwd);
  assert.deepEqual(resumedChild.externalSessionId, child.externalSessionId, "child resumes");

  // 8. Continue on the resumed branches — must keep context.
  const rMain = [];
  for await (const ev of adapter2.sendMessage(resumedMain.sessionKey, { text: "After restart: reply with SURVIVED_MAIN" })) rMain.push(ev);
  const textRM = rMain.filter((e) => e.kind === "assistant").map((e) => e.text).join("");
  assert.match(textRM, /SURVIVED_MAIN/, "main survived restart and continued");

  const rChild = [];
  for await (const ev of adapter2.sendMessage(resumedChild.sessionKey, { text: "After restart: reply with SURVIVED_CHILD" })) rChild.push(ev);
  const textRC = rChild.filter((e) => e.kind === "assistant").map((e) => e.text).join("");
  assert.match(textRC, /SURVIVED_CHILD/, "child survived restart");

  // 9. Same display name / label doesn't affect resumption (keyed by external id).
  assert.notEqual(resumedMain.externalSessionId, resumedChild.externalSessionId);

  // Cleanup: terminate all registry entries in both adapters.
  await Promise.all([adapter.terminate(mainKey), adapter.terminate(childKey), adapter.terminate(gKey)]);
});

// Scenario A (ACCEPTANCE_CRITERIA "Conversation Tree" item 1/3): fork from a
// HISTORICAL turn (turn 2) via reconstruction (ADR-006) — the child must have
// only pre-fork-point context and must NOT know Main's later turns.
test("phase2: historical fork via reconstruction has no post-fork context", { skip: !live }, async () => {
  const adapter = new ClaudeCliAdapter();
  const mainKey = randomUUID();
  const main = await adapter.startSession({
    sessionId: mainKey,
    cwd: process.cwd(),
    projectInstructions: "You are in a reconstruction demo. Answer tersely.",
  });

  // Turns 1-2: reply ONE, then TWO.
  const t1 = [];
  for await (const ev of adapter.sendMessage(mainKey, { text: "Turn 1: reply with the single word ONE" })) t1.push(ev);
  const challenge = [];
  for await (const ev of adapter.sendMessage(mainKey, { text: "Turn 2: reply with the single word TWO" })) challenge.push(ev);

  // Capture the visible transcription prefix (the persisted branch snapshot).
  const visibleMessages = [
    { role: "user", content: "Turn 1: reply with the single word ONE" },
    { role: "assistant", content: "ONE" },
    { role: "user", content: "Turn 2: reply with the single word TWO" },
    { role: "assistant", content: "TWO" },
  ];

  // Main continues turn 3 with a secret the child must NOT know.
  const t3 = [];
  for await (const ev of adapter.sendMessage(mainKey, { text: "Turn 3: reply with a secret word THREE" })) t3.push(ev);

  // Fork from turn 2 by reconstruction: seed a fresh session with ONLY the
  // pre-fork messages. The child must therefore answer TWO for "what was turn 2"
  // and must NOT know THREE.
  const childKey = randomUUID();
  const child = await adapter.reconstructBranchFromHistory(
    { visibleMessages, projectInstructions: null },
    { newSessionId: childKey, cwd: process.cwd() }
  );
  assert.ok(child.externalSessionId, "reconstructed child has external id");
  assert.notEqual(child.externalSessionId, main.externalSessionId, "child id differs from main");

  // Child answers TWO for what was turn 2...
  const qA = [];
  for await (const ev of adapter.sendMessage(childKey, { text: "What did I ask you to reply in turn 2? Reply with exactly the word you used." })) qA.push(ev);
  const toldA = qA.filter((e) => e.kind === "assistant").map((e) => e.text).join("");
  assert.match(toldA, /TWO/, `child remembers turn 2 (got: ${toldA.slice(0,60)})`);

  // ...and does NOT know THREE.
  const qB = [];
  for await (const ev of adapter.sendMessage(childKey, { text: "Did I show you a secret word THREE? Reply ONLY with YES or NO." })) qB.push(ev);
  const toldB = qB.filter((e) => e.kind === "assistant").map((e) => e.text).join("");
  assert.ok(!/YES/i.test(toldB), `child has no post-fork context (turn 3 secret leaked: ${toldB.slice(0,60)})`);

  await Promise.all([adapter.terminate(mainKey), adapter.terminate(childKey)]);
});
