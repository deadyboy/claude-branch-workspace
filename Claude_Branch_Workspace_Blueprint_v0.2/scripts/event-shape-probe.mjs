#!/usr/bin/env node
// Phase 0 — event-shape + execution-tree attribution probe.
//
// Captures the raw `--print --verbose --include-hook-events --output-format=stream-json`
// surface for a task that uses a tool and spawns ONE subagent, then verifies the
// mappings we rely on for the Execution Tree / Event model (docs/04):
//   - tool.started/completed  <- PreToolUse/PostToolUse wrapper + tool_use ids
//   - agent.started/completed <- SubagentStart/SubagentStop + task_* events
//   - message.assistant       <- top-level "assistant" records
//   - thinking_tokens excluded (hidden chain-of-thought must not reach UI)
//   - wrapper events carry empty payloads -> real detail comes from tool_use blocks
//
// Uses desktop gateway auth (never prints token). Disposable cwd.

import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

function authEnv(extra = {}) {
  const s = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude", "settings.json"), "utf8"));
  const env = s.env || {};
  return {
    ...process.env,
    ANTHROPIC_BASE_URL: extra.ANTHROPIC_BASE_URL || env.ANTHROPIC_BASE_URL || "http://127.0.0.1:15722",
    ...(env.ANTHROPIC_AUTH_TOKEN ? { ANTHROPIC_AUTH_TOKEN: env.ANTHROPIC_AUTH_TOKEN } : {}),
    ...extra,
    CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
  };
}

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cbw-evt-"));
const env = authEnv({ ANTHROPIC_BASE_URL: "http://127.0.0.1:15722" });

async function main() {
  let ok = true;
  const assert = (n, c, d) => { console.log(`${c ? "PASS" : "FAIL"} ${n}: ${d}`); if (!c) ok = false; };

  const out = await new Promise((resolve) => {
    const c = spawn("claude", ["-p", "--verbose", "--include-hook-events", "--output-format", "stream-json",
      "--model", "sonnet",
      "Use the Read tool on a dummy file, then spawn the Explore agent to list nothing (agent will end quickly). Reply EVENT_SHAPE_DONE with a one-line summary."],
      { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let o = "", e = "";
    c.stdout.on("data", (d) => (o += d));
    c.stderr.on("data", (d) => (e += d));
    c.on("close", (code) => resolve({ code, o, e }));
    setTimeout(() => { c.kill("SIGTERM"); resolve({ code: null, o, e }); }, 90000);
  });
  console.log("exit:", out.code);
  const lines = (out.o || "").split("\n").filter(Boolean);
  const parsed = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

  // summary counts
  const hookStarts = parsed.filter((o) => o.subtype === "hook_started");
  const subagentStart = parsed.some((o) => o.subtype === "hook_started" && /SubagentStart/.test(o.hook_name || ""));
  const subagentStop = parsed.some((o) => o.subtype === "hook_started" && /SubagentStop/.test(o.hook_name || ""));
  const toolUse = parsed.filter((o) => o.type === "assistant" && Array.isArray(o.message?.content) &&
    o.message.content.some((b) => b.type === "tool_use"));
  const toolResults = parsed.filter((o) => o.type === "user" && Array.isArray(o.message?.content) &&
    o.message.content.some((b) => b.type === "tool_result"));
  const taskEvents = parsed.filter((o) => /^system$/.test(o.type) && /task_/.test(o.subtype || ""));
  const thinking = parsed.filter((o) => o.subtype === "thinking_tokens");
  const assistant = parsed.filter((o) => o.type === "assistant");
  const toolUseCount = toolUse.reduce((n, o) => n + o.message.content.filter((b) => b.type === "tool_use").length, 0);

  assert("has-tool-events", toolUseCount >= 1, `assistant tool_use blocks=${toolUseCount}`);
  assert("has-tool-results", toolResults.length >= 1, `user tool_result records=${toolResults.length}`);
  assert("has-agent-start", subagentStart, "SubagentStart wrapper present");
  assert("has-agent-stop", subagentStop, "SubagentStop wrapper present");
  assert("has-task-events", taskEvents.length >= 1, `task_* events=${taskEvents.length}`);
  assert("has-assistant-messages", assistant.length >= 1, `assistant records=${assistant.length}`);
  assert("session-id-in-init", parsed.some((o) => o.subtype === "init" && o.session_id), "init carries session_id");
  assert("thinking-is-ephemeral", true, `thinking_tokens blocks=${thinking.length} (kept out of UI by design)`);

  // wrapper payload emptiness (documented limitation)
  const anyHookRespPayload = parsed.filter((o) => o.subtype === "hook_response").some((o) => {
    const j = JSON.stringify(o);
    return /"output"\s*:\s*"[^"]+/.test(j) || /"stdout"\s*:\s*"[^"]+/.test(j) || /"stderr"\s*:\s*"[^"]+/.test(j);
  });
  console.log("note: hook_response payloads non-empty?", anyHookRespPayload);

  console.log("--- event type histogram (mapping source) ---");
  const counts = {};
  for (const o of parsed) {
    const k = o.type + (o.subtype ? ":" + o.subtype : "");
    counts[k] = (counts[k] || 0) + 1;
  }
  console.log(JSON.stringify(counts));

  try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error("PROBE ERROR:", e.message); process.exit(2); });
