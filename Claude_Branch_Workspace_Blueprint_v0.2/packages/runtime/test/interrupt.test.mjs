import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCliAdapter } from "../dist/index.js";

// Fake `claude`: a start (-session or -version) call completes fast with a
// normal transcript; a `--resume` call emits init + an assistant snippet and
// then HANGS so the test can interrupt it mid-turn. This drives the real
// interrupt path: SIGTERM → close → runTurn settles → generator ends.
function writeHangOnResumeFake(dir) {
  const bin = join(dir, "fake-interrupt.mjs");
  const script = `import { stdout, argv } from 'node:process';
const isResume = argv.includes('--resume');
stdout.write(JSON.stringify({ type:'system', subtype:'init', session_id:'INT-EXT', runtime_version:'2.1.226-fake' }) + '\\n');
if (!isResume) {
  stdout.write(JSON.stringify({ type:'assistant', message:{ id:'m0', role:'assistant', content:[{ type:'text', text:'SESSION_READY' }] } }) + '\\n');
  stdout.write(JSON.stringify({ type:'result', is_error:false, stop_reason:'end_turn', session_id:'INT-EXT' }) + '\\n');
} else {
  stdout.write(JSON.stringify({ type:'assistant', message:{ id:'m1', role:'assistant', content:[{ type:'text', text:'WORKING…' }] } }) + '\\n');
  process.on('SIGTERM', () => process.exit(0));
  setTimeout(() => {}, 90_000); // hang until killed
}
`;
  writeFileSync(bin, script);
  return ["node", bin];
}

async function collect(adapter, key, text, into) {
  try {
    for await (const ev of adapter.sendMessage(key, { text })) into.push(ev);
  } catch (e) {
    into.error = e;
  }
}

test("g6 adapter: interrupt kills only the targeted session's child; other session unaffected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cbw-interrupt-"));
  try {
    const [fakeBin, fakeScript] = writeHangOnResumeFake(dir);
    const adapter = new ClaudeCliAdapter(fakeBin, [fakeScript]);

    const main = await adapter.startSession({ sessionId: "main-1", cwd: dir, workspaceMode: "shared" });
    const child = await adapter.startSession({ sessionId: "child-1", cwd: dir, workspaceMode: "shared" });
    assert.equal(main.sessionKey, "main-1");
    assert.equal(child.sessionKey, "child-1");

    // Launch both turns (both hang on --resume).
    const mainEvents = [];
    const childEvents = [];
    const mainP = collect(adapter, "main-1", "main turn", mainEvents);
    const childP = collect(adapter, "child-1", "child turn", childEvents);

    // Give both children time to spawn + emit init/assistant, then hang.
    await new Promise((r) => setTimeout(r, 600));

    // Interrupt ONLY the child.
    await adapter.interrupt("child-1");
    await childP;

    // Child was cancelled.
    assert.ok(adapter.wasInterrupted("child-1"), "child session observed as interrupted");
    assert.ok(
      childEvents.some((e) => e.kind === "assistant"),
      "child captured its assistant text before the kill"
    );

    // Main was NOT interrupted.
    assert.equal(adapter.wasInterrupted("main-1"), false, "main session not marked interrupted");
    assert.ok(mainEvents.some(e => e.kind === "assistant"), "main progress streamed while child remains alive");
    assert.ok(!mainEvents.some(e => e.kind === "result"), "main has not completed or been killed");

    // Now interrupt main too; it settles and is observed interrupted.
    await adapter.interrupt("main-1");
    await mainP;
    assert.ok(adapter.wasInterrupted("main-1"));

    await adapter.terminate("main-1");
    await adapter.terminate("child-1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g6 adapter: interrupt with no in-flight child is a no-op (no crash)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cbw-interrupt-idle-"));
  try {
    const [fakeBin, fakeScript] = writeHangOnResumeFake(dir);
    const adapter = new ClaudeCliAdapter(fakeBin, [fakeScript]);
    await adapter.startSession({ sessionId: "idle-1", cwd: dir, workspaceMode: "shared" });
    await adapter.interrupt("idle-1"); // no in-flight child
    assert.equal(adapter.wasInterrupted("idle-1"), false);
    // unknown session: no-op
    await adapter.interrupt("ghost");
    await adapter.terminate("idle-1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
