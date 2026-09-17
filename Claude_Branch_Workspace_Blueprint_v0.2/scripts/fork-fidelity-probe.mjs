#!/usr/bin/env node
// Phase 0 — automated fork-fidelity probe (Scenario A seed).
//
// Proves, with disposable isolated per-branch cwds and auto-memory disabled:
//   1. root has 3 turns with distinct secret values;
//   2. a child reconstructed at turn 2 knows turn1..2 ONLY and NOT turn3;
//   3. the child does NOT inherit unrelated memory from root (no cross-branch leak);
//   4. the root is not mutated by the fork/reconstruction.
//
// Reads the desktop-app gateway auth from ~/.claude/settings.json (env block)
// and injects it so the child `claude` processes can authenticate. This is the
// same trust domain the desktop app itself uses; no secret is printed or logged.

import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

// ---------- auth env ----------
function authEnv(extra = {}) {
  const settings = JSON.parse(
    fs.readFileSync(path.join(os.homedir(), ".claude", "settings.json"), "utf8")
  );
  const env = settings.env || {};
  // The ACTIVE per-process gateway may differ from the (possibly stale) settings value.
  // 15722 is the live gateway observed; prefer an override or fall back to settings.
  const baseUrl = extra.ANTHROPIC_BASE_URL || env.ANTHROPIC_BASE_URL || "http://127.0.0.1:15722";
  return {
    ...process.env,
    ANTHROPIC_BASE_URL: baseUrl,
    ...(env.ANTHROPIC_AUTH_TOKEN ? { ANTHROPIC_AUTH_TOKEN: env.ANTHROPIC_AUTH_TOKEN } : {}),
    ...extra,
    CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
  };
}

// ---------- spawn helper (async, closed stdin — verified not to hang) ----------
function run(claudeArgs, { cwd, env, timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn("claude", claudeArgs, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ code: null, signal: "TIMEOUT", out, err });
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, out, err });
    });
  });
}

// ---------- isolated branch workspace ----------
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cbw-root-"));
const CHILD = fs.mkdtempSync(path.join(os.tmpdir(), "cbw-child-"));
const ROOT_ID = crypto.randomUUID();
const CHILD_ID = crypto.randomUUID();

// Per-branch settings that disable auto-memory so no user-level memory leaks across branches.
function branchSettingsJson(projectMemoryDir) {
  return JSON.stringify({
    autoMemoryMemoryDir: projectMemoryDir,
    autoMemoryMemory: false,
    permissions: { defaultMode: "acceptEdits" },
  });
}
const rootSettings = path.join(ROOT, "settings.json");
const childSettings = path.join(CHILD, "settings.json");
fs.writeFileSync(rootSettings, branchSettingsJson(path.join(ROOT, "mem")));
fs.writeFileSync(childSettings, branchSettingsJson(path.join(CHILD, "mem")));

const baseArgs = ["-p", "--model", "sonnet"];

function rootEnv() {
  return authEnv({ ANTHROPIC_BASE_URL: "http://127.0.0.1:15722" });
}

async function main() {
  console.log("=== FORK FIDELITY PROBE ===");
  const results = {};
  let ok = true;

  // 1) root: 3 turns (use neutral "workspace settings" facts the model will store,
  //    not "secret" wording which triggers saving refusals and contaminates the test)
  const t1 = await run([...baseArgs, "--session-id", ROOT_ID, "--settings", rootSettings,
    "Note a project setting for this workspace: theme_note = theme_a. Reply T1_OK"], { cwd: ROOT, env: rootEnv() });
  results.t1 = { code: t1.code, out: t1.out.trim() };

  const t2 = await run([...baseArgs, "--resume", ROOT_ID, "--settings", rootSettings,
    "Note another setting: palette_note = palette_b. Reply T2_OK"], { cwd: ROOT, env: rootEnv() });
  results.t2 = { code: t2.code, out: t2.out.trim() };

  const t3 = await run([...baseArgs, "--resume", ROOT_ID, "--settings", rootSettings,
    "Note a third setting: accent_note = accent_c. Reply T3_OK"], { cwd: ROOT, env: rootEnv() });
  results.t3 = { code: t3.code, out: t3.out.trim() };

  // 2) child reconstructed at turn 2 (seed only turns 1..2; no turn 3)
  const seed = [
    "You are continuing from a fork of a prior conversation.",
    "Visible conversation UP TO the fork point (earlier turns):",
    "User: Note a project setting for this workspace: theme_note = theme_a. Assistant: T1_OK",
    "User: Note another setting: palette_note = palette_b. Assistant: T2_OK",
    "",
    "This is a NEW branch. Reply: CHILD_SEEDED_OK",
  ].join("\n");
  const c1 = await run([...baseArgs, "--session-id", CHILD_ID, "--settings", childSettings, seed],
    { cwd: CHILD, env: rootEnv() });
  results.c1 = { code: c1.code, out: (c1.out || "").trim() };

  // 3) child must know theme_a & palette_b, NOT accent_c
  const c2 = await run([...baseArgs, "--resume", CHILD_ID, "--settings", childSettings,
    "Which workspace setting values do you know? Reply only as comma-separated name=value, exactly the ones you know."],
    { cwd: CHILD, env: rootEnv() });
  results.c2 = { code: c2.code, out: (c2.out || "").trim() };
  const childKnows = (c2.out || "").toLowerCase();
  const knowsA = /theme_a/.test(childKnows);
  const knowsB = /palette_b/.test(childKnows);
  const knowsC = /accent_c/.test(childKnows);

  // 4) root unaffected by child protocol — and root DID learn turn3's accent_c
  const r3 = await run([...baseArgs, "--resume", ROOT_ID, "--settings", rootSettings,
    "Which value does accent_note have? Reply only the value or UNKNOWN"], { cwd: ROOT, env: rootEnv() });
  results.r3 = { code: r3.code, out: (r3.out || "").trim() };
  const rootKnowsC = /accent_c/.test((r3.out || "").toLowerCase());

  // assertions
  const assert = (name, cond, detail) => {
    results[name] = { pass: cond, detail };
    if (!cond) ok = false;
    console.log(`${cond ? "PASS" : "FAIL"} ${name}: ${detail}`);
  };

  assert("root-3-turns-ok", t1.code === 0 && t2.code === 0 && t3.code === 0, "root T1/T2/T3 exit codes");
  assert("child-seeded-ok", c1.code === 0, "child first turn exit code");
  assert("child-knows-theme_a", knowsA, "child seeded with theme_a");
  assert("child-knows-palette_b", knowsB, "child seeded with palette_b");
  assert("child-not-know-accent_c", !knowsC, "child must NOT know accent_c (post-fork leak)");
  assert("root-has-own-third-note", rootKnowsC, "root still knows its own accent_c (not mutated by child)");
  assert("child-not-inherit-root-future-memory", !/accent_c/.test(childKnows), "no cross-branch future memory");

  console.log("\n--- raw outputs (tokens may contain tool chatter; values kept) ---");
  for (const [k] of Object.entries(results)) {
    const r = results[k];
    if (r.pass === undefined) console.log(`${k}: code=${r.code} out=${JSON.stringify(r.out)}`);
    else console.log(`${k}: ${r.pass ? "PASS" : "FAIL"} ${r.detail} :: ${JSON.stringify(r.out)}`);
  }

  // cleanup disposable dirs
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(CHILD, { recursive: true, force: true }); } catch {}

  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error("PROBE ERROR:", e.message); process.exit(2); });
