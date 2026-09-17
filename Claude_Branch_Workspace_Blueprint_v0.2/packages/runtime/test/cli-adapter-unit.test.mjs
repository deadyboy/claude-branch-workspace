import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCliAdapter } from "../dist/index.js";

// Unit tests that exercise the adapter's CLI-arg construction + event parsing
// WITHOUT a live gateway: we substitute a fake `claude` on PATH that just
// echoes a stream-json transcript. Requires CBW_CLAUDE_BIN to point at the fake.

// Fake `claude` as a plain node script so no shell is needed for the spawn;
// production always uses shell:false (no arg-injection surface).
function writeFakeClaude(dir) {
  const bin = join(dir, "fake-claude.mjs");
  const script = `import { stdout } from 'node:process';
if (process.argv.includes('--version')) {
  stdout.write('2.1.226-fake\\n');
  process.exit(0);
}
stdout.write(JSON.stringify({ type:'system', subtype:'init', session_id:'FAKE-EXT', runtime_version:'2.1.226-fake' }) + '\\n');
stdout.write(JSON.stringify({ type:'assistant', message:{ id:'m1', role:'assistant', content:[{ type:'text', text:'HELLO_FAKE' }] } }) + '\\n');
stdout.write(JSON.stringify({ type:'result', is_error:false, stop_reason:'end_turn', session_id:'FAKE-EXT' }) + '\\n');
`;
  writeFileSync(bin, script);
  return ["node", bin];
}

test("adapter builds correct CLI args and parses init/assistant/result", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cbw-fake-"));
  const [fakeBin, fakeScript] = writeFakeClaude(dir);
  const cwd = dir;

  const adapter = new ClaudeCliAdapter(fakeBin, [fakeScript]);
  const caps = await adapter.getCapabilities();
  assert.ok(caps.eventStream);

  const sess = await adapter.startSession({
    sessionId: "uk-1",
    cwd,
    workspaceMode: "shared",
  });
  assert.equal(sess.externalSessionId, "FAKE-EXT");
  assert.equal(sess.sessionKey, "uk-1");

  const events = [];
  for await (const ev of adapter.sendMessage("uk-1", { text: "hi" })) events.push(ev);
  const text = events.filter((e) => e.kind === "assistant").map((e) => e.text).join("");
  assert.equal(text, "HELLO_FAKE");
  assert.ok(events.some((e) => e.kind === "result"));

  await adapter.terminate("uk-1");
  rmSync(dir, { recursive: true, force: true });
});

// Real stream-json nests tool blocks in message.content[]. The adapter must
// surface tool_use / tool_result from there (review MAJOR #2), and must NOT
// mislabel unrelated events (user/assistant/system noise) as task events.
function writeToolFakeClaude(dir) {
  const bin = join(dir, "fake-tools.mjs");
  const script = `import { stdout } from 'node:process';
stdout.write(JSON.stringify({ type:'system', subtype:'init', session_id:'TOOLS-EXT', runtime_version:'2.1.226-fake' }) + '\\n');
// assistant with BOTH text and a nested tool_use block
stdout.write(JSON.stringify({ type:'assistant', message:{ id:'m1', role:'assistant', content:[
  { type:'text', text:'READING ' },
  { type:'tool_use', id:'tu_1', name:'Read', input:{ file_path:'a.ts' } }
] } }) + '\\n');
// user message carrying a nested tool_result
stdout.write(JSON.stringify({ type:'user', message:{ id:'u1', role:'user', content:[
  { type:'tool_result', tool_use_id:'tu_1', is_error:false, content:'CONTENT_HERE' }
] } }) + '\\n');
// an unrelated "control_request" event must be dropped, not become a task
stdout.write(JSON.stringify({ type:'control_request', request:'interrupt', uuid:'z' }) + '\\n');
// a real subagent task_* (system:task_started)
stdout.write(JSON.stringify({ type:'system', subtype:'task_started', uuid:'ag_9', status:'running' }) + '\\n');
stdout.write(JSON.stringify({ type:'assistant', message:{ id:'m2', role:'assistant', content:[{ type:'text', text:'DONE' }] } }) + '\\n');
stdout.write(JSON.stringify({ type:'result', is_error:false, stop_reason:'end_turn', session_id:'TOOLS-EXT' }) + '\\n');
`;
  writeFileSync(bin, script);
  return ["node", bin];
}

test("parseEvent: nested tool_use/tool_result + task_* are parsed; unrelated events dropped", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cbw-fake-tools-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const [fakeBin, fakeScript] = writeToolFakeClaude(dir);
  const adapter = new ClaudeCliAdapter(fakeBin, [fakeScript]);
  await adapter.startSession({ sessionId: "tt-1", cwd: dir, workspaceMode: "shared" });

  const events = [];
  for await (const ev of adapter.sendMessage("tt-1", { text: "go" })) events.push(ev);

  const toolUses = events.filter((e) => e.kind === "tool_use");
  assert.ok(toolUses.length >= 1, "tool_use surfaced from nested message.content[]");
  assert.equal(toolUses[0].name, "Read");
  assert.deepEqual(toolUses[0].input, { file_path: "a.ts" });

  const toolResults = events.filter((e) => e.kind === "tool_result");
  assert.ok(toolResults.length >= 1, "tool_result surfaced from user message content");
  assert.equal(toolResults[0].toolUseId, "tu_1");
  assert.equal(toolResults[0].isError, false);

  const tasks = events.filter((e) => e.kind === "task");
  const interesting = tasks.filter((e) => e.type !== "task_started");
  assert.equal(interesting.length, 0, "unrelated events are dropped, not mislabeled as tasks");
  assert.ok(tasks.some((e) => e.id === "ag_9" && e.type === "task_started"), "subagent task_started parsed");

  await adapter.terminate("tt-1");
});

// A fake that never emits result and never exits: the adapter must surface a
// timeout error (SIGTERM + reject) instead of hanging forever (review MAJOR #3).
function writeHangFakeClaude(dir) {
  const bin = join(dir, "fake-hang.mjs");
  const script = `import { stdout } from 'node:process';
process.on('SIGTERM', () => process.exit(0));
stdout.write(JSON.stringify({ type:'system', subtype:'init', session_id:'HANG-EXT' }) + '\\n');
stdout.write(JSON.stringify({ type:'assistant', message:{ id:'m1', role:'assistant', content:[{ type:'text', text:'HALF' }] } }) + '\\n');
setTimeout(() => {}, 60_000); // never completes
`;
  writeFileSync(bin, script);
  return ["node", bin];
}

test("timeout: a hung child surfaces an error instead of hanging forever", async () => {
  const scriptDir = mkdtempSync(join(tmpdir(), "cbw-fake-hang-"));
  // The hung child keeps its CWD (os.tmpdir()) alive, not scriptDir, so cleanup
  // of scriptDir is safe even if the child lingers on Windows.
  const hangCwd = tmpdir();
  try {
    const [fakeBin, fakeScript] = writeHangFakeClaude(scriptDir);
    const adapter = new ClaudeCliAdapter(fakeBin, [fakeScript], undefined, 2000, 2000);
    await assert.rejects(
      adapter.startSession({ sessionId: "hg-1", cwd: hangCwd, workspaceMode: "shared" }),
      /timed|timeout/i,
      "hang produces a timeout error, not an indefinite await"
    );
  } finally {
    rmSync(scriptDir, { recursive: true, force: true });
  }
});

test("adapter CAPABILITIES match reality (no optimistic flags)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cbw-fake2-"));
  const [fakeBin, fakeScript] = writeFakeClaude(dir);
  const adapter = new ClaudeCliAdapter(fakeBin, [fakeScript]);
  const caps = await adapter.getCapabilities();
  // These are the ones Phase 0 / this environment actually verified.
  assert.equal(caps.persistentSessions, true);
  assert.equal(caps.resume, true);
  assert.equal(caps.forkFromHead, true);
  assert.equal(caps.nativeSubagents, true);
  assert.equal(caps.eventStream, true);
  // Not verified / not available in this CLI version:
  assert.equal(caps.lifecycleHooks, false, "hook wrappers carry empty payloads");
  assert.equal(caps.interactivePermissions, false, "print-mode is non-interactive");
  rmSync(dir, { recursive: true, force: true });
});
