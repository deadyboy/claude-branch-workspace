import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, realpath, stat } from "node:fs/promises";
import { resolve, dirname, basename, join, relative, isAbsolute } from "node:path";
import type { DomainService, Branch } from "@cbw/domain";

const exec = promisify(execFile);
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, ...args], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

/** Explicit, persisted workspace ownership. Archiving never deletes files. */
export class WorkspaceManager {
  constructor(private svc: DomainService) {}

  async bind(branch: Branch, requestedCwd?: string | null): Promise<string> {
    if (branch.workspacePath) return branch.workspacePath;
    const project = this.svc.getProject(branch.projectId);
    const parent = branch.parentBranchId ? this.svc.getBranch(branch.parentBranchId) : null;
    const base = await realpath(resolve(requestedCwd ?? parent?.workspacePath ?? project?.rootPath ?? process.cwd()));
    if (!(await stat(base)).isDirectory()) throw new Error("workspace must be a directory");
    if (branch.workspaceMode === "shared") {
      this.svc.bindBranchWorkspace(branch.id, { mode: "shared", path: base });
      // E4a: record the baseline once, best-effort. A shared non-Git folder has
      // no HEAD, so baseRef stays null rather than failing the bind.
      await this.recordBaseRef(branch.id, base);
      return base;
    }
    const root = await git(base, ["rev-parse", "--show-toplevel"]);
    // Reconstructing conversation does not reconstruct uncommitted files.
    // Refuse a dirty source rather than silently dropping the user's edits.
    if (await git(root, ["status", "--porcelain", "--untracked-files=normal"])) {
      throw new Error("worktree source has uncommitted changes; commit or use shared mode");
    }
    const common = await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const owner = resolve(common, "..");
    const container = join(dirname(owner), `${basename(owner)}.cbw-worktrees`);
    await mkdir(container, { recursive: true });
    const target = join(await realpath(container), branch.id);
    // Detached HEAD avoids inventing user git branches; the persistent app
    // branch owns this worktree. Changes and commits remain until explicit cleanup.
    await git(root, ["worktree", "add", "--detach", target, "HEAD"]);
    this.svc.bindBranchWorkspace(branch.id, { mode: "worktree", path: target });
    // E4a: the worktree was created FROM root's HEAD, and `worktree add` leaves
    // root's HEAD untouched — so reading it now still yields the creation-time
    // commit. Only recorded on (and ever written on) this first bind.
    await this.recordBaseRef(branch.id, root);
    return target;
  }

  /**
   * E4a baseline (docs/14 §4.2): record the workspace's HEAD as baseRef, ONCE.
   * The domain write is guarded by `base_ref IS NULL`, so a restart or re-bind
   * cannot move the "before work began" point. Best-effort: a non-Git workspace
   * (ordinary folder, or a repo with no commit) simply has no baseline.
   */
  private async recordBaseRef(branchId: string, cwd: string): Promise<void> {
    let head = "";
    try {
      head = await git(cwd, ["rev-parse", "HEAD"]);
    } catch {
      return; // not a Git repo, or no first commit — no baseline to record
    }
    if (head) this.svc.recordBaseRef(branchId, head);
  }

  async status(branchId: string) {
    const branch = this.svc.getBranch(branchId);
    if (!branch) throw new Error("branch not found");
    if (!branch.workspacePath) return { mode: branch.workspaceMode, path: null, dirty: false, conflicts: [], sharedWith: [] };
    let dirty = false;
    let conflicts: string[] = [];
    let isGit = true;
    try {
      dirty = Boolean(await git(branch.workspacePath, ["status", "--porcelain"]));
      conflicts = (await git(branch.workspacePath, ["diff", "--name-only", "--diff-filter=U"])).split(/\r?\n/).filter(Boolean);
    } catch { isGit = false; }
    const sharedWith = this.svc.listProjects().flatMap(p =>
      // Domain owns branch queries; no runtime session data exposed.
      this.svc.listBranches(p.id)).filter(b => b.id !== branch.id && b.status === "active" && b.workspacePath === branch.workspacePath).map(b => b.id);
    return { mode: branch.workspaceMode, path: branch.workspacePath, isGit, dirty, conflicts, sharedWith };
  }

  async cleanup(branchId: string): Promise<void> {
    const branch = this.svc.getBranch(branchId);
    if (!branch || branch.status !== "archived" || branch.workspaceMode !== "worktree" || !branch.workspacePath) {
      throw new Error("cleanup requires an archived, managed worktree");
    }
    const target = await realpath(branch.workspacePath);
    const common = await git(target, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const owner = resolve(common, "..");
    const container = await realpath(join(dirname(owner), `${basename(owner)}.cbw-worktrees`));
    const rel = relative(container, target);
    if (isAbsolute(rel) || rel.startsWith("..") || rel !== branch.id) throw new Error("workspace is outside managed boundary");
    if (await git(target, ["status", "--porcelain"])) throw new Error("workspace has changes; cleanup refused");
    const head = await git(target, ["rev-parse", "HEAD"]);
    if (!(await git(owner, ["branch", "--contains", head])).trim()) throw new Error("workspace has unmerged commits; cleanup refused");
    await git(owner, ["worktree", "remove", target]); // no force; git also refuses unsafe removal
    this.svc.bindBranchWorkspace(branchId, { mode: "worktree", path: null });
  }
}
