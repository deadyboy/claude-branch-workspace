#!/usr/bin/env node
// Phase 3 — capture the RAW stream-json hook/task event shapes so the
// normalizer reads the exact fields the current CLI emits (observed behavior
// wins over docs). Runs ONE short task (a Read + one subagent), writes the raw
// JSON lines to a TEMP file (never git/DB), and prints a compact field map of
// each event subtype we rely on for the execution tree.
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const settings = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude", "settings.json"), "utf8"));
const env = settings.env || {};
const envFull = {
  ...process.env,
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL || env.ANTHROPIC_BASE_URL || "http://127.0.0.1:15722",
  ...(env.ANTHROPIC_AUTH_TOKEN ? { ANTHROPIC_AUTH_TOKEN: env.ANTHROPIC_AUTH_TOKEN } : {}),
  CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
};

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cbw-hookshp-"));
const outFile = path.join(os.tmpdir(), `cbw-hookshp-raw-${process.pid}.jsonl`);
const prompt = [
  "Use the Read tool on a file named nothing.txt (it does not exist). ",
  "Then spawn ONE Explore subagent whose task is 'return immediately with OK'. ",
  "Then reply HOOK_DONE.",
].join("");

async function main() {
  const start = Date.now();
  const { code, o } = await new Promise((resolve) => {
    const c = spawn("claude", [
      "-p", "--verbose", "--include-hook-events", "--output-format", "stream-json",
      "--model", "sonnet", prompt,
    ], { cwd, env: envFull, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (err += d));
    c.on("close", () => resolve({ code: c.exitCode, o: out, e: err }));
    setTimeout(() => { c.kill("SIGTERM"); resolve({ code: null, o: out, e: err }); }, 240000);
  });
  fs.writeFileSync(outFile, o, "utf8");
  console.log(`exit=${code} ms=${Date.now() - start} rawBytes=${o.length} out=${outFile}`);

  const parsed = o.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const hist = {};
  for (const e of parsed) {
    const k = e.type + (e.subtype ? ":" + e.subtype : "");
    hist[k] = (hist[k] || 0) + 1;
  }
  console.log("HISTOGRAM:", JSON.stringify(hist));

  const seen = new Set();
  for (const e of parsed) {
    const k = e.type + (e.subtype ? ":" + e.subtype : "");
    if (/hook|task|permission|progress/i.test(k) && !seen.has(k)) {
      seen.add(k);
      // print ONLY structural keys + non-secret sample fields
      const s = { type: e.type, subtype: e.subtype, keys: Object.keys(e) };
      for (const f of ["hook_name", "hook_event_name", "status", "uuid", "subtask_uuid", "session_id", "task_id", "parent_uuid", "agent_name", "name", "tool_name"]) {
        if (e[f] !== undefined) s[f] = String(e[f]);
      }
      if (e.hook_event_name && e.hook_event_name !== "PreToolUse" && e.hook_event_name !== "PostToolUse") {
        s.raw = JSON.stringify(e).slice(0, 400);
      }
      console.log("SHAPE", JSON.stringify(s));
    }
  }
  try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
  console.log("DONE raw at", outFile);
}

main().catch((e) => { console.error("PROBE ERROR", e.message); process.exit(2); });
