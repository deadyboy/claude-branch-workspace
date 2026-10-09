import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeCliAdapter } from "../dist/index.js";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "cbw-native-fork-"));
  const cwd = join(root, "source"), target = join(root, "worktree"), config = join(root, "config");
  const previousConfig = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  t.after(() => {
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfig;
    rmSync(root, { recursive: true, force: true });
  });
  const project = join(config, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(project, { recursive: true }); mkdirSync(cwd); mkdirSync(target);
  const sessionId = randomUUID();
  const ids = Array.from({ length: 6 }, () => randomUUID());
  const bodies = [
    { role: "user", content: "Read the earlier reference" },
    { id: "api-tool", role: "assistant", content: [{ type: "tool_use", id: "read-1", name: "Read", input: { file_path: "reference.txt" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "read-1", content: "PAST_REFERENCE" }] },
    { id: "api-final", role: "assistant", content: [{ type: "text", text: "PAST_REFERENCE" }] },
    { role: "user", content: "FUTURE_REFERENCE" },
    { id: "api-future", role: "assistant", content: [{ type: "text", text: "FUTURE_REFERENCE" }] },
  ];
  // Synthetic native CLI records are test fixtures only. Production reads and
  // forks through the SDK and never constructs or rewrites transcript records.
  const rows = bodies.map((message, i) => ({
    type: message.role, uuid: ids[i], parentUuid: ids[i - 1] ?? null,
    sessionId, timestamp: new Date(1700000000000 + i * 1000).toISOString(), cwd,
    isSidechain: false, message,
  }));
  const path = join(project, `${sessionId}.jsonl`);
  writeFileSync(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  return { sessionId, ids, cwd, target, path, project };
}

test("real SDK disk fork preserves tools, inclusive cutoff, UUID map, and parent bytes without a model invocation", async t => {
  const f = fixture(t);
  const adapter = new ClaudeCliAdapter("nonexistent-cli-must-not-be-spawned");
  const parent = await adapter.resumeSession(f.sessionId, f.cwd);
  const hash = () => createHash("sha256").update(readFileSync(f.path)).digest("hex");
  const before = hash();
  const child = await adapter.forkFromHistoricalNode(parent.sessionKey, {
    newSessionId: randomUUID(), runtimeMessageId: f.ids[3], cwd: f.target,
  });
  assert.notEqual(child.externalSessionId, f.sessionId);
  assert.equal(child.forkedFromExternalSessionId, f.sessionId);
  assert.equal(child.cwd, f.target);
  assert.equal(child.running, false);
  assert.deepEqual(Object.keys(child.runtimeMessageIdMap), f.ids.slice(0, 4));
  assert.ok(Object.entries(child.runtimeMessageIdMap).every(([oldId, newId]) => oldId !== newId));
  const messages = await getSessionMessages(child.externalSessionId);
  const parentMessages = await getSessionMessages(f.sessionId);
  assert.deepEqual(messages.map(m => m.message), parentMessages.slice(0, 4).map(m => m.message),
    "native fork keeps exact tool input, tool result, message content and order");
  assert.deepEqual(messages.map(m => m.uuid), f.ids.slice(0, 4).map(id => child.runtimeMessageIdMap[id]));
  assert.ok(JSON.stringify(messages).includes('"type":"tool_use"'));
  assert.ok(JSON.stringify(messages).includes('"type":"tool_result"'));
  assert.ok(JSON.stringify(messages).includes("PAST_REFERENCE"));
  assert.ok(!JSON.stringify(messages).includes("FUTURE_REFERENCE"));
  assert.equal(hash(), before);
  assert.equal((await getSessionMessages(child.externalSessionId, { dir: f.target })).length, 0,
    "native disk transcript stays in source project even when continuation cwd differs");

  // Restart recovers the persisted local key. SDK UUID lookup must find the
  // transcript despite a target worktree cwd, and remap IDs again for a grandchild.
  const restarted = new ClaudeCliAdapter("nonexistent-cli-must-not-be-spawned", [], {
    getRuntimeSessionByExternalId(id) {
      return id === child.externalSessionId ? { id: child.sessionKey, branchId: "child", externalSessionId: id } : null;
    },
  });
  const resumed = await restarted.resumeSession(child.externalSessionId, f.target);
  assert.equal(resumed.sessionKey, child.sessionKey);
  const copiedBoundary = child.runtimeMessageIdMap[f.ids[3]];
  const grandchild = await restarted.forkFromHistoricalNode(resumed.sessionKey, {
    newSessionId: randomUUID(), runtimeMessageId: copiedBoundary, cwd: f.target,
  });
  assert.ok(grandchild.runtimeMessageIdMap[copiedBoundary]);
  assert.notEqual(grandchild.runtimeMessageIdMap[copiedBoundary], copiedBoundary);
  assert.equal((await getSessionMessages(grandchild.externalSessionId)).length, 4);
  assert.equal(hash(), before);
});

test("native historical fork rejects missing boundary and duplicate session key without materializing a fork", async t => {
  const f = fixture(t);
  const adapter = new ClaudeCliAdapter("nonexistent-cli-must-not-be-spawned");
  const parent = await adapter.resumeSession(f.sessionId, f.cwd);
  const before = readdirSync(f.project).sort();
  await assert.rejects(adapter.forkFromHistoricalNode(parent.sessionKey, {
    newSessionId: randomUUID(), runtimeMessageId: randomUUID(),
  }), /not found/);
  await assert.rejects(adapter.forkFromHistoricalNode(parent.sessionKey, {
    newSessionId: randomUUID(), runtimeMessageId: "",
  }), /requires a transcript UUID/);
  await assert.rejects(adapter.forkFromHistoricalNode(parent.sessionKey, {
    newSessionId: parent.sessionKey, runtimeMessageId: f.ids[3],
  }), /already registered/);
  assert.deepEqual(readdirSync(f.project).sort(), before);
});

test("completed UUID prefix can fork while the parent is running a later turn", async t => {
  const f = fixture(t);
  const script = join(f.cwd, "running.mjs");
  writeFileSync(script, `console.log(JSON.stringify({type:'system',subtype:'init',session_id:${JSON.stringify(f.sessionId)}})); setTimeout(()=>{},60000);`);
  const adapter = new ClaudeCliAdapter(process.execPath, [script]);
  const parent = await adapter.resumeSession(f.sessionId, f.cwd);
  const stream = adapter.sendMessage(parent.sessionKey, { text: "later running turn" })[Symbol.asyncIterator]();
  assert.equal((await stream.next()).value.kind, "init");
  try {
    const child = await adapter.forkFromHistoricalNode(parent.sessionKey, {
      newSessionId: randomUUID(), runtimeMessageId: f.ids[3],
    });
    assert.ok(child.runtimeMessageIdMap[f.ids[3]]);
    assert.ok(!JSON.stringify(await getSessionMessages(child.externalSessionId)).includes("FUTURE_REFERENCE"));
  } finally {
    await adapter.interrupt(parent.sessionKey);
    await stream.return();
  }
});
