import { test } from "node:test";
import assert from "node:assert/strict";
import { scrub, buildRedactedPayload } from "../dist/redact.js";
import { EventBus } from "../dist/event-bus.js";

test("scrub redacts secret keys and secret-shaped values", () => {
  const out = scrub({
    name: "Claude",
    apiKey: "sk-live-1234567890abcdef",
    auth: "Bearer xyz",
    token: "t",
    nested: { password: "hunter2", fine: "hello", deep: ["a", "sk-aaaa1111bbbb2222"] },
  });
  assert.equal(out.name, "Claude");
  assert.equal(out.apiKey, "[REDACTED]");
  assert.equal(out.auth, "[REDACTED]");
  assert.equal(out.token, "[REDACTED]");
  assert.equal(out.nested.password, "[REDACTED]");
  assert.equal(out.nested.fine, "hello");
  assert.equal(out.nested.deep[0], "a");
  assert.equal(out.nested.deep[1], "[REDACTED]");
});

test("buildRedactedPayload allowlists tool input per tool", () => {
  // Read carries file_path; Bash carries command; a mouse/paint tool carries nothing.
  const a = buildRedactedPayload({
    eventId: "x", type: "tool.started", occurredAt: "t", receivedAt: "t",
    projectId: "p", branchId: "b", nodeId: null, agentRunId: null, runtimeSessionId: "r",
    sequence: 1, toolName: "Read", toolInput: { file_path: "a.ts", rest: "secret" },
  });
  assert.equal(a.tool, "Read");
  assert.equal(a.file_path, "a.ts");
  assert.equal(a.rest, undefined, "non-allowlisted tool input key dropped");

  const b = buildRedactedPayload({
    eventId: "x", type: "tool.started", occurredAt: "t", receivedAt: "t",
    projectId: "p", branchId: "b", nodeId: null, agentRunId: null, runtimeSessionId: "r",
    sequence: 1, toolName: "Bash", toolInput: { command: "ls -la" },
  });
  assert.equal(b.command, "ls -la");

  const c = buildRedactedPayload({
    eventId: "x", type: "tool.started", occurredAt: "t", receivedAt: "t",
    projectId: "p", branchId: "b", nodeId: null, agentRunId: null, runtimeSessionId: "r",
    sequence: 1, toolName: "Task", toolInput: { secret: "sk-live-abcdef1234567890" },
  });
  assert.equal(c.tool, "Task");
  assert.equal(c.secret, undefined, "unknown tool: no payload at all");
});

test("scrub redacts secret-shaped values inside Bash/summary/text, keeps benign export", () => {
  const KEY = "sk-live-ABCDEFG123456789XYZ";
  const base = {
    eventId: "x", type: "tool.started", occurredAt: "t", receivedAt: "t",
    projectId: "p", branchId: "b", nodeId: null, agentRunId: null, runtimeSessionId: "r", sequence: 1,
  };

  // token in a bash command must be scrubbed even mid-string
  const bash = buildRedactedPayload({ ...base, toolName: "Bash", toolInput: { command: `export ANTHROPIC_API_KEY=${KEY} && echo hi` } });
  assert.equal(bash.command, "[REDACTED]", "token inside bash command redacted");

  // benign export of a non-secret value passes through
  const benign = buildRedactedPayload({ ...base, toolName: "Bash", toolInput: { command: "export NOT_A_KEY=k && true" } });
  assert.equal(benign.command, "export NOT_A_KEY=k && true", "benign export preserved");

  // ordinary bash passes
  assert.equal(buildRedactedPayload({ ...base, toolName: "Bash", toolInput: { command: "ls -la" } }).command, "ls -la");

  // assistant text and agent summary redact embedded tokens
  const text = buildRedactedPayload({ ...base, type: "message.assistant.completed", text: `my key is ${KEY} end` });
  assert.equal(text.text, "[REDACTED]");
  const summary = buildRedactedPayload({ ...base, type: "agent.started", summary: `task using ${KEY}` });
  assert.equal(summary.task, "[REDACTED]");

  // benign words are not flagged
  assert.equal(buildRedactedPayload({ ...base, type: "message.assistant.completed", text: "notification service is fine" }).text, "notification service is fine");
});

test("scrub redacts assignment of a secret-shaped value under an env var", () => {
  assert.equal(scrub("set AWS_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE123456"), "[REDACTED]", "env assignment of a secret-shaped value redacted");
});

test("event bus fans out globally and per-branch, with replay", () => {
  const bus = new EventBus();
  const seen = [];
  const mk = (branchId, type) => ({
    eventId: "e", projectId: "p", branchId, nodeId: null, agentRunId: null,
    runtimeSessionId: null, type, sequence: 1, occurredAt: "t", receivedAt: "t", payload: {},
  });

  bus.publish(mk("b1", "session.started"));
  bus.publish(mk("b2", "tool.started"));

  const labels = [];
  bus.subscribe((ev) => labels.push(`all:${ev.branchId}`), { replay: true });
  bus.subscribeBranch("b2", (ev) => labels.push(`b2:${ev.type}`), { replay: true });

  bus.publish(mk("b2", "tool.completed"));

  assert.ok(labels.includes("all:b1"));
  assert.ok(labels.includes("all:b2"));
  assert.ok(labels.includes("b2:tool.started"), "branch replay covers pre-subscribe b2 event");
  assert.ok(labels.includes("b2:tool.completed"), "live b2 event delivered");
  assert.ok(!labels.some((l) => l === "b2:session.started"), "other branch not delivered to b2 sub");
});
