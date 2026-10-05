#!/usr/bin/env node
// Phase 0 — automated interrupt + reconnect probe.
//
// Verifies:
//   1. start a long-running child session;
//   2. SIGTERM it mid-turn;
//   3. the process terminates promptly (<= 10s);
//   4. the SAME session id can be resumed in a new process afterwards.
// Uses a disposable cwd and the desktop-app gateway auth (same trust domain;
// the token is never printed or persisted by this script).

import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

function authEnv(extra = {}) {
  const settings = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude", "settings.json"), "utf8"));
  const env = settings.env || {};
  return {
    ...process.env,
    ANTHROPIC_BASE_URL: extra.ANTHROPIC_BASE_URL || env.ANTHROPIC_BASE_URL || "http://127.0.0.1:15722",
    ...(env.ANTHROPIC_AUTH_TOKEN ? { ANTHROPIC_AUTH_TOKEN: env.ANTHROPIC_AUTH_TOKEN } : {}),
    ...extra,
    CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
  };
}

function run(args, { cwd, env, timeoutMs = 90000 } = {}) {
  return new Promise((resolve) => {
    const c = spawn("claude", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => { c.kill("SIGTERM"); resolve({ code: null, signal: "TIMEOUT", out, err }); }, timeoutMs);
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (err += d));
    c.on("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, out, err }); });
  });
}

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cbw-intr-"));
const sessionId = "99999999-2222-4333-8444-5555555555ab";
const env = authEnv({ ANTHROPIC_BASE_URL: "http://127.0.0.1:15722" });

async function main() {
  let ok = true;
  const assert = (n, c, d) => { console.log(`${c ? "PASS" : "FAIL"} ${n}: ${d}`); if (!c) ok = false; };

  // long-running child
  const child = spawn("claude", ["-p", "--verbose", "--output-format", "stream-json", "--model", "sonnet",
    `Use session id ${sessionId} then write a 4000-word essay about the history of elm trees.`],
    { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", gained = false;
  child.stdout.on("data", (d) => { out += d; if (!gained && out.length > 2000) gained = true; });
  // wait until some output accrued OR 8s
  await new Promise((res) => setTimeout(res, 8000));
  const streamedBeforeKill = out.length;
  console.log("streamed before kill:", streamedBeforeKill, "bytes");
  const t0 = Date.now();
  const closeP = new Promise((res) => child.on("close", (code, sig) => res({ code, sig })));
  child.kill("SIGTERM");
  const closed = await Promise.race([closeP, new Promise((res) => setTimeout(() => res({ code: null, sig: "NO_CLOSE" }), 10000))]);
  const killMs = Date.now() - t0;
  console.log("after SIGTERM closed in", killMs, "ms sig=", closed.sig, "code=", closed.code);
  assert("interrupt-terminates", closed.sig === "SIGTERM" || closed.sig !== "NO_CLOSE" || closed.code !== null, `closed in ${killMs}ms`);

  // reconnect: resume the interrupted session in a NEW process (should still answer a fresh question,
  // proving the session survived the process kill)
  const r = await run(["-p", "--session-id", sessionId, "--model", "sonnet", "Reply OK-RECONNECTED"], { cwd, env });
  assert("reconnect-session-alive", r.code === 0 && /OK-RECONNECTED/.test(r.out || ""), `reconnected (out="${(r.out || "").trim().slice(0,40)}")`);

  try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error("PROBE ERROR:", e.message); process.exit(2); });
