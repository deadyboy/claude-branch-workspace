// Project capability probe (S1, docs/14 §4.1). Answers "can this project run
// an isolated worktree branch right now, and if not, why?" — the honest
// pre-flight the ProjectHub shows before a user picks a workspace mode.
//
// `worktreeAvailable` reflects whether a worktree can be created AT THIS MOMENT.
// `sharedAvailable` is always true: shared-dir chat never requires Git.
//
// Why `dirty` counts as unavailable (S0 §4.1 "dirty 单独不为 false 的唯一理由"):
// the freeze says dirty ALONE must not be the ONLY thing that disables the whole
// project — shared mode stays open, which is exactly what sharedAvailable:true
// encodes. But the question worktreeAvailable answers is "can I create a
// worktree now?", and the answer when the source is dirty is NO: WorkspaceManager
// .bind() refuses a dirty source (workspace-manager.ts:30). Reporting true here
// would let the user attempt a bind that always throws. So a dirty source is
// reported unavailable with an actionable reason ("commit first, or use shared
// mode"), and the UI still offers shared mode.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stat } from "node:fs/promises";
import type { Project, ProjectCapabilities } from "@cbw/domain";

const exec = promisify(execFile);

// Same invocation shape as WorkspaceManager (execFile + windowsHide) so the
// two probes agree on what "a git repo" and "dirty" mean.
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, ...args], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

/** Probe a project's rootPath for Git/worktree readiness. Never throws. */
export async function probeProjectCapabilities(project: Project): Promise<ProjectCapabilities> {
  const rootPath = project.rootPath;
  const base: ProjectCapabilities = {
    rootPath,
    exists: false,
    isGit: false,
    dirty: false,
    hasCommits: false,
    worktreeAvailable: false,
    worktreeReason: null,
    sharedAvailable: true,
  };

  // 1) Path must be a reachable directory on THIS host (docs/14 §3 — the
  // control-plane host is the execution host). A null/missing path fails here.
  if (!rootPath) {
    return { ...base, worktreeReason: "项目未设置 rootPath，无法创建 worktree；共享模式可用" };
  }
  const dirStat = await stat(rootPath).catch(() => null);
  if (!dirStat?.isDirectory()) {
    return { ...base, worktreeReason: "路径不可访问或不是目录，无法创建 worktree；共享模式可用" };
  }
  base.exists = true;

  // 2) Must be inside a Git working tree.
  let topLevel = "";
  try {
    topLevel = await git(rootPath, ["rev-parse", "--show-toplevel"]);
  } catch {
    topLevel = "";
  }
  if (!topLevel) {
    return { ...base, worktreeReason: "不是 Git 仓库，无法创建 worktree；共享模式可用" };
  }
  base.isGit = true;

  // 3) Must have at least one commit — `git worktree add HEAD` has no HEAD to
  // derive from on a freshly-initialized repository.
  let hasCommits = false;
  try {
    await git(rootPath, ["rev-parse", "--verify", "HEAD"]);
    hasCommits = true;
  } catch {
    hasCommits = false;
  }
  base.hasCommits = hasCommits;
  if (!hasCommits) {
    return { ...base, worktreeReason: "仓库尚无首个提交，无法创建 worktree；共享模式可用（可先提交一次）" };
  }

  // 4) A dirty source is refused at worktree creation (workspace-manager.ts:30),
  // so report it unavailable now with the actionable fix — not a hard project block.
  let dirty = false;
  try {
    dirty = Boolean(await git(rootPath, ["status", "--porcelain", "--untracked-files=normal"]));
  } catch {
    dirty = false;
  }
  base.dirty = dirty;
  if (dirty) {
    return { ...base, worktreeReason: "源目录有未提交改动，创建 worktree 时会被拒绝；请先提交，或使用共享模式" };
  }

  return { ...base, worktreeAvailable: true, worktreeReason: null };
}
