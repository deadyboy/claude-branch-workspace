#!/usr/bin/env node
// E1/E4a fixed sample projects (plan doc 13 §4.2): P1 clean Git project,
// P2 plain folder, P3 boundary project.
//
// Purely additive experiment scaffolding. Does NOT touch product code.
//
// Usage:
//   node scripts/experiments/make-fixtures.mjs [--out <dir>]
//
// Default --out is F:\CodexTemp\cbw-ui-x\<run-id> (run-id = timestamp + random
// suffix). Emits <out>/manifest.json — the judge truth for E1/E4a (absolute
// paths, the P1 initial commit hash, and a per-sample file inventory).

import {
  mkdirSync, writeFileSync, existsSync, readdirSync, statSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";

// ---------- args ----------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") out.out = argv[++i];
    else if (a.startsWith("--out=")) out.out = a.slice("--out=".length);
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

// run-id: timestamp + random suffix; also used for the default output dir.
function makeRunId() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${ts}-${randomBytes(3).toString("hex")}`;
}

// Forward-slash absolute path (repo convention; portable in truth files).
const toPosix = (p) => resolve(p).split(sep).join("/");

function writeFile(p, content) {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content, "utf8");
}

// ---------- git helper (deterministic, host-config-independent) ----------
const FIXED_AUTHOR_NAME = "CBW Fixture";
const FIXED_AUTHOR_EMAIL = "fixture@cbw.example.invalid";
const FIXED_AUTHOR_DATE = "2020-01-01T00:00:00+00:00";

// -c overrides make the commit hash reproducible regardless of the host's
// global git config: no autocrlf conversion (LF stays LF), no gpgsign, no
// hooks. All three P1 files are added before the single commit.
function git(repoDir, args, extraEnv = {}) {
  return execFileSync(
    "git",
    [
      "-C", repoDir,
      "-c", "core.autocrlf=false",
      "-c", "core.safecrlf=false",
      "-c", "commit.gpgsign=false",
      "-c", `user.name=${FIXED_AUTHOR_NAME}`,
      "-c", `user.email=${FIXED_AUTHOR_EMAIL}`,
      ...args,
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: FIXED_AUTHOR_NAME,
        GIT_AUTHOR_EMAIL: FIXED_AUTHOR_EMAIL,
        GIT_AUTHOR_DATE: FIXED_AUTHOR_DATE,
        GIT_COMMITTER_NAME: FIXED_AUTHOR_NAME,
        GIT_COMMITTER_EMAIL: FIXED_AUTHOR_EMAIL,
        GIT_COMMITTER_DATE: FIXED_AUTHOR_DATE,
        // Never inherit a global hooks/template path.
        GIT_CONFIG_NOSYSTEM: "1",
        ...extraEnv,
      },
    }
  );
}

// ---------- file inventory ----------
// Recursive list of files relative to root, forward slashes, sorted. `.git`
// directories are skipped (P3 holds two repos; VCS internals are not fixture
// content and are non-deterministic).
function walk(root) {
  const out = [];
  const stack = [""];
  while (stack.length) {
    const rel = stack.pop();
    const abs = rel ? join(root, rel) : root;
    for (const name of readdirSync(abs)) {
      if (name === ".git") continue;
      const childRel = rel ? `${rel}/${name}` : name;
      const childAbs = join(root, childRel);
      if (statSync(childAbs).isDirectory()) stack.push(childRel);
      else out.push(childRel);
    }
  }
  return out.sort();
}

// ---------- P1: clean Git project ----------
// A minimal TypeScript function with a real "add empty-input handling" target,
// a README, and a Node-runnable test (Node >= 22 strips TS types natively).
const P1_SRC = `// Minimal fixture module. E3 asks the agent to "add empty-input handling to
// the existing function and run the existing tests".
export function formatGreeting(name: string): string {
  return \`Hello, \${name.trim()}!\`;
}
`;

const P1_TEST = `import { test } from "node:test";
import assert from "node:assert/strict";
import { formatGreeting } from "../src/greeting.ts";

test("formats a normal name", () => {
  assert.equal(formatGreeting("World"), "Hello, World!");
});

test("trims surrounding whitespace", () => {
  assert.equal(formatGreeting("  Ada  "), "Hello, Ada!");
});
`;

const P1_README = `# p1-clean-git

Minimal TypeScript fixture for the CBW visual-workspace experiments (E1/E4a).

## Module

- \`src/greeting.ts\` — \`formatGreeting(name)\`.

## Test

\`\`\`
node --test test/greeting.test.mjs
\`\`\`

This repository intentionally starts clean (no uncommitted changes) so a
worktree can be created from it.
`;

function makeP1(root) {
  writeFile(join(root, "src", "greeting.ts"), P1_SRC);
  writeFile(join(root, "test", "greeting.test.mjs"), P1_TEST);
  writeFile(join(root, "README.md"), P1_README);

  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["add", "src/greeting.ts", "test/greeting.test.mjs", "README.md"]);
  git(root, ["commit", "-q", "-m", "Initial CBW fixture commit"]);

  const commit = git(root, ["rev-parse", "HEAD"]).trim();
  const files = git(root, ["ls-files"]).trim().split("\n").filter(Boolean).sort();
  const status = git(root, ["status", "--porcelain"]).trim();

  return {
    kind: "git",
    id: "P1",
    root: toPosix(root),
    git: true,
    initialCommit: commit,
    branch: "main",
    clean: status === "",
    files,
    purpose: "Clean Git project: execution, worktree, diff (E1/E3/E4a).",
  };
}

// ---------- P2: plain folder, no Git ----------
const P2_NOTES = {
  "notes/topic-a.md": `# Topic A — synthetic research note

Deterministic synthetic content for the CBW project-graph experiment (E8).
This folder has no Git repository on purpose (plain-folder / shared mode).

- finding-a1
- finding-a2
`,
  "notes/topic-b.md": `# Topic B — synthetic research note

Second synthetic note. Used to exercise directory containment and the
"project graph works for non-code projects" claim (E8).

- finding-b1
`,
  "notes/summary.md": `# Summary

Synthetic summary affine to topic-a and topic-b. Referenced by E4a as a
declared report file that must exist when the UI reports it.
`,
};

function makeP2(root) {
  for (const [rel, content] of Object.entries(P2_NOTES)) writeFile(join(root, rel), content);
  // P2 must have NO .git of its own. (Check for the directory directly — a
  // parent container being a repo would make `rev-parse` report true wrongly.)
  const hasGitDir = existsSync(join(root, ".git"));
  return {
    kind: "folder",
    id: "P2",
    root: toPosix(root),
    git: false,
    files: walk(root),
    purpose: "Plain folder, no Git: non-code project, shared mode, project graph (E1/E8).",
    // Asserted false by the generator; E1 relies on this being a non-Git dir.
    hasGitDir,
  };
}

// ---------- P3: boundary project ----------
function makeP3(root) {
  const sub = {
    spaced: join(root, "folder with spaces"),
    cjk: join(root, "中文目录"),
    dirty: join(root, "dirty-repo"),
    noCommit: join(root, "no-first-commit"),
  };

  // 1) path with an ASCII space
  writeFile(join(sub.spaced, "note with space.md"), "# Spaced path\n\nPath contains an ASCII space.\n");

  // 2) path with Chinese characters
  writeFile(join(sub.cjk, "笔记.md"), "# 中文路径\n\n路径与文件名含中文，用于路径与能力提示验收。\n");

  // 3) a Git repo with uncommitted (dirty) changes
  writeFile(join(sub.dirty, "tracked.txt"), "version 1\n");
  git(sub.dirty, ["init", "-q", "-b", "main"]);
  git(sub.dirty, ["add", "tracked.txt"]);
  git(sub.dirty, ["commit", "-q", "-m", "initial"]);
  writeFile(join(sub.dirty, "tracked.txt"), "version 1\nuncommitted edit\n");
  writeFile(join(sub.dirty, "untracked.txt"), "brand new, untracked\n");

  // 4) a Git repo with NO first commit (init only)
  mkdirSync(sub.noCommit, { recursive: true });
  git(sub.noCommit, ["init", "-q", "-b", "main"]);
  writeFile(join(sub.noCommit, "work-in-progress.txt"), "staged-worthy content, never committed\n");

  // (5) "inaccessible path" is a scenario, not a fixture: the experiment
  // references a path that does not exist. We record one to use verbatim.
  const inaccessible = toPosix(join(root, "does-not-exist-" + randomBytes(2).toString("hex")));

  return {
    kind: "boundary",
    id: "P3",
    root: toPosix(root),
    paths: {
      spacedDir: toPosix(sub.spaced),
      cjkDir: toPosix(sub.cjk),
      dirtyRepo: toPosix(sub.dirty),
      noFirstCommitRepo: toPosix(sub.noCommit),
      inaccessible: inaccessible, // guaranteed-absent path for E1
    },
    expectations: {
      spacedDir: "path with an ASCII space must open",
      cjkDir: "Chinese path must open / render",
      dirtyRepo: "dirty source: shared mode OK; worktree creation refused with reason",
      noFirstCommitRepo: "no first commit: worktree unavailable with reason",
      inaccessible: "server must return an explicit execution-host path error",
    },
    files: walk(root),
    purpose: "Boundary paths and capability prompts (E1 P3 边界).",
  };
}

// ---------- main ----------
function main() {
  const args = parseArgs(process.argv.slice(2));
  const runId = makeRunId();
  const out = resolve(
    args.out ?? join("F:\\CodexTemp\\cbw-ui-x", runId)
  );

  if (existsSync(out)) {
    // Refuse to clobber an existing experiment dir unless it is empty.
    if (readdirSync(out).length > 0) {
      throw new Error(`output dir already exists and is not empty: ${out}`);
    }
  }
  mkdirSync(out, { recursive: true });

  const p1Dir = join(out, "P1-clean-git");
  const p2Dir = join(out, "P2-plain-folder");
  const p3Dir = join(out, "P3-boundary");
  for (const d of [p1Dir, p2Dir, p3Dir]) mkdirSync(d, { recursive: true });

  const p1 = makeP1(p1Dir);
  const p2 = makeP2(p2Dir);
  const p3 = makeP3(p3Dir);

  const manifest = {
    schema: "cbw.experiments.fixtures/v1",
    runId,
    createdAt: new Date().toISOString(),
    generatedBy: "scripts/experiments/make-fixtures.mjs",
    host: { platform: process.platform, node: process.version },
    out: toPosix(out),
    samples: { P1: p1, P2: p2, P3: p3 },
    note:
      "Judge truth for E1 (project entry, execution host, boundary paths) and " +
      "E4a (file change review vs. the P1 initialCommit + file list).",
  };
  writeFile(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  // ---- human-readable summary ----
  console.log("=== CBW fixtures ===");
  console.log(`out          : ${toPosix(out)}`);
  console.log(`P1 root      : ${p1.root}`);
  console.log(`P1 commit    : ${p1.initialCommit}  branch=${p1.branch} clean=${p1.clean}`);
  console.log(`P1 files     : ${p1.files.join(", ")}`);
  console.log(`P2 root      : ${p2.root}  (git=${p2.git}, hasGitDir=${p2.hasGitDir})`);
  console.log(`P2 files     : ${p2.files.join(", ")}`);
  console.log(`P3 root      : ${p3.root}`);
  console.log(`  spaced     : ${p3.paths.spacedDir}`);
  console.log(`  cjk        : ${p3.paths.cjkDir}`);
  console.log(`  dirty      : ${p3.paths.dirtyRepo}`);
  console.log(`  no-commit  : ${p3.paths.noFirstCommitRepo}`);
  console.log(`  absent     : ${p3.paths.inaccessible}`);
  console.log(`manifest     : ${toPosix(join(out, "manifest.json"))}`);
}

try {
  main();
} catch (e) {
  console.error("FIXTURE ERROR:", e.message);
  process.exitCode = 1;
}

// re-export for potential reuse / testing (has no effect when run directly)
export { makeRunId, toPosix };
