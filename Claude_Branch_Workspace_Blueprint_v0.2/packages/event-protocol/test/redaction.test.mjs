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

test("LEAK FALSE-POSITIVE REGRESSION: secret-shaped run must redact the WHOLE string even as a prefix/substring (security review MAJOR)", () => {
  const KEY = "sk-live-ABCDEFG123456789XYZ";
  const cases = [
    // URL / query / path-segment — the run is bounded by non-secret chars on both sides
    `curl https://x/key/${KEY}?q=1`,
    `${KEY}?q=1`,
    `key/${KEY}/seg`,
    // env-var assignment
    `export FOO=${KEY}ZZZZ`,
    // embedded in assistant text (any longer value)
    `my key is ${KEY} end`,
    // a longer opaque value starting with sk- + 16+ chars
    `${KEY}ZZZZ`,
  ];
  for (const s of cases) {
    assert.equal(scrub(s), "[REDACTED]", `whole-string redact: ${s.slice(0, 40)}`);
  }
  // benign — must NOT be flagged
  for (const good of ["notification", "mask-12345678901234567", "task-id-1234567890ab", "export NOT_A_KEY=k && true"]) {
    assert.equal(scrub(good), good, `benign kept: ${good}`);
  }
});

test("review P0: redacts the additional secret classes reviewer identified", () => {
  // GitHub credentials
  assert.equal(scrub("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij"), "[REDACTED]", "classic PAT");
  assert.equal(scrub("token=github_pat_11ABCDEFG1234567890abcdefghijklmnopqrstuv"), "[REDACTED]", "fine-grained PAT");
  assert.equal(scrub("echo gho_1234567890abcdefghijklmnopqrstuvwxyz12"), "[REDACTED]", "gho token in bash");
  // Authorization / Bearer / JWT
  assert.equal(scrub("Authorization: Bearer abc.def.ghiJklMnoPqrsTuvWxYz0123456789ab"), "[REDACTED]", "Bearer header");
  assert.equal(scrub("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig1234567890abcdef"), "[REDACTED]", "JWT");
  // password passthrough
  assert.equal(scrub("curl -u user --password Sup3rS3cretXyz1"), "[REDACTED]", "--password");
  assert.equal(scrub("password=MyP@ssw0rd!2026"), "[REDACTED]", "password= inline");
  // PEM private key (in a bash command / output)
  const pem = "cat key.pem # -----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234567890abcdef\n-----END RSA PRIVATE KEY-----";
  assert.equal(scrub(pem), "[REDACTED]", "PEM private key block");
  // cookie value passthrough
  // (cookie with an opaque value is caught by the opaque-looking inline rule only
  //  when it reaches 8+ non-space chars — a long session id qualifies)
  assert.equal(scrub("Cookie: session=l3JLK1mN2oP3qR4sT5uV6wX7yZ8"), "[REDACTED]", "long opaque cookie session");

  // benign — must stay unchanged
  for (const good of [
    "ghp_ is an abbreviation, fine",
    "Bearer is a word",
    "eyJ is not a jwt unless three segments",
    "--password 123456",           // short / placeholder-ish
    "password: default",           // known placeholder
    "PRIVATE KEY not matched without a block",
  ]) {
    assert.equal(scrub(good), good, `benign kept: ${good}`);
  }
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
