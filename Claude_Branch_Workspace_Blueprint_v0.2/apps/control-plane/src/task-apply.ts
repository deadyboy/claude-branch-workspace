// E4b — applying a branch's result back to a TARGET directory (docs/14 §4.3).
//
// POST /api/tasks/:id/apply  { preview: true }                  → ApplyPreview
// POST /api/tasks/:id/apply  { preview: false, confirmToken }   → ApplyResult
//
// The whole unit is built around one rule: NEVER silently overwrite. Concretely:
//
//   * PREVIEW is a pure read. It reuses computeBranchChanges (never re-parses
//     git) and touches NOTHING in the target directory.
//   * TARGET DIRECTORY = an explicit `targetPath` if the caller passes one, else
//     the project's `rootPath` (the same place the workspace came from). It is
//     refused when it is missing, equals the source workspace, or is a bare repo.
//   * confirmToken = a hash over (task/source descriptor + the exact file ops +
//     the ENTIRE target directory fingerprint). Apply recomputes it and, on any
//     mismatch, REFUSES and reports which of the three inputs changed — it never
//     attempts a best-effort merge.
//   * CONFLICT detection compares the target's current blob to the blob the
//     source branched from (baseRef for committed changes, the pre-change blob
//     for working-tree changes). If the target moved off that base — or a file
//     that did not exist at base now does — the file is a conflict and apply
//     stops. "Deletes" obey the same rule.
//   * IDEMPOTENCY: the ledger row id is a deterministic hash of
//     (task, branch, target). A second apply with the same token finds the row
//     and REPLAYS the recorded outcome instead of writing again.
//   * MID-APPLY FAILURE: every file we are about to touch has its prior content
//     held in memory; on the first error we roll the already-written files back
//     and report `targetRestored`. If even the rollback fails we say so
//     (`partial`, targetRestored:false) — never "all applied".

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type {
  ApplyConflict,
  ApplyFileSummary,
  ApplyPreview,
  ApplyResult,
  Branch,
  BranchChanges,
  ChangeEntry,
  ChangeStatus,
  DomainService,
} from "@cbw/domain";
import { computeBranchChanges } from "./branch-changes.js";

const exec = promisify(execFile);

// Same invocation shape as branch-changes / workspace-manager.
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, ...args], {
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    encoding: "utf8",
  });
  return stdout;
}

async function tryGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    return await git(cwd, args);
  } catch {
    return null;
  }
}

/** Run git feeding `input` on stdin; returns raw stdout bytes. */
function gitWithInput(cwd: string, args: string[], input: Buffer): Promise<Buffer> {
  return new Promise((res, rej) => {
    const child = execFile(
      "git",
      ["-C", cwd, ...args],
      { windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: "buffer" },
      (err, stdout) => (err ? rej(err) : res(stdout as Buffer))
    );
    child.stdin?.end(input);
  });
}

/** Raw blob bytes of a committed object (never goes through the index). */
async function gitBuffer(cwd: string, args: string[]): Promise<Buffer> {
  return new Promise((res, rej) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      { windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: "buffer" },
      (err, stdout) => (err ? rej(err) : res(stdout as Buffer))
    );
  });
}

// Windows git accepts forward slashes in pathspecs and emits them in -z output.
const posix = (p: string): string => p.split("\\").join("/");

function sha256hex(s: string | Buffer): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Git's own blob hash for raw bytes (used only for non-git targets). */
function rawBlobOid(content: Buffer): string {
  return createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
}

// ---- file state probes ----

interface TreeEntry {
  mode: string; // "100644" | "100755" | "120000"
  oid: string;
}

/** Parse `git ls-tree -z <rev> -- <paths>` into a path→entry map. */
function parseLsTreeZ(out: string): Map<string, TreeEntry> {
  const map = new Map<string, TreeEntry>();
  for (const rec of out.split("\0")) {
    if (!rec) continue;
    // "<mode> <type> <oid>\t<path>"
    const tab = rec.indexOf("\t");
    if (tab < 0) continue;
    const meta = rec.slice(0, tab).split(/\s+/);
    const path = rec.slice(tab + 1);
    if (meta.length < 3) continue;
    map.set(path, { mode: meta[0], oid: meta[2] });
  }
  return map;
}

/** The committed state of `paths` at `rev` (missing paths simply absent). */
async function treeAt(cwd: string, rev: string, paths: string[]): Promise<Map<string, TreeEntry>> {
  if (!paths.length) return new Map();
  const out = await tryGit(cwd, ["ls-tree", "-z", rev, "--", ...paths]);
  return parseLsTreeZ(out ?? "");
}

/** The index (HEAD) state of one path: "100644 <oid> 0\t<path>". */
async function indexEntry(cwd: string, path: string): Promise<TreeEntry | null> {
  const out = await tryGit(cwd, ["ls-files", "--stage", "-z", "--", path]);
  if (!out) return null;
  const rec = out.split("\0").find(Boolean);
  if (!rec) return null;
  const tab = rec.indexOf("\t");
  const meta = (tab >= 0 ? rec.slice(0, tab) : rec).split(/\s+/);
  if (meta.length < 2) return null;
  return { mode: meta[0], oid: meta[1] };
}

/**
 * Oid of a worktree file as git would store it (filters applied via --path, so
 * an autocrlf checkout still hashes to its normalized repo blob). null = absent.
 */
async function worktreeOid(cwd: string, rel: string): Promise<string | null> {
  let content: Buffer;
  try {
    content = await readFile(join(cwd, rel));
  } catch {
    return null;
  }
  try {
    const out = await gitWithInput(cwd, ["hash-object", `--path=${posix(rel)}`, "--stdin"], content);
    return out.toString("utf8").trim() || null;
  } catch {
    return rawBlobOid(content);
  }
}

/** Oid of a file inside the TARGET dir (raw hash when the target is not git). */
async function targetFileOid(targetDir: string, rel: string, isGit: boolean): Promise<string | null> {
  let content: Buffer;
  try {
    content = await readFile(join(targetDir, rel));
  } catch {
    return null;
  }
  if (!isGit) return rawBlobOid(content);
  try {
    const out = await gitWithInput(targetDir, ["hash-object", `--path=${posix(rel)}`, "--stdin"], content);
    return out.toString("utf8").trim() || null;
  } catch {
    return rawBlobOid(content);
  }
}

async function isGitRepo(cwd: string): Promise<boolean> {
  return (await tryGit(cwd, ["rev-parse", "--is-inside-work-tree"]))?.trim() === "true";
}

async function isDirty(cwd: string): Promise<boolean> {
  const out = await tryGit(cwd, ["status", "--porcelain", "--untracked-files=normal"]);
  return out != null && out.trim().length > 0;
}

// ---- target fingerprints / path safety ----

/** Reject a relative path that would escape the target directory. */
function resolveInside(targetDir: string, rel: string): string {
  const abs = resolve(targetDir, rel);
  const base = resolve(targetDir);
  if (abs !== base && !abs.startsWith(base + sep)) {
    throw new Error(`path escapes target directory: ${rel}`);
  }
  return abs;
}

const MAX_FINGERPRINT_FILES = 5000;

/** Every file path (posix, repo-relative) the target currently contains. */
async function listTargetFiles(targetDir: string, isGit: boolean): Promise<string[]> {
  if (isGit) {
    const out = await tryGit(targetDir, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
    return (out ?? "").split("\0").filter(Boolean).map(posix).sort();
  }
  // Plain folder: a bounded recursive walk, skipping .git.
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    if (out.length >= MAX_FINGERPRINT_FILES) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FINGERPRINT_FILES) return;
      if (e.name === ".git") continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.isFile()) out.push(posix(relative(targetDir, abs)));
    }
  }
  await walk(targetDir);
  return out.sort();
}

/** Content fingerprint of the WHOLE target dir — the token's anchor. */
async function targetFingerprint(targetDir: string, isGit: boolean): Promise<string> {
  const files = await listTargetFiles(targetDir, isGit);
  const parts: string[] = [];
  for (const rel of files) {
    try {
      const buf = await readFile(join(targetDir, rel));
      parts.push(`${rel}:${sha256hex(buf)}`);
    } catch {
      parts.push(`${rel}:<unreadable>`);
    }
  }
  return sha256hex(parts.join("\n"));
}

// ---- source manifest ----

interface ManifestEntry {
  path: string;
  action: "write" | "delete";
  status: ChangeStatus;
  group: "committed" | "uncommitted" | "untracked";
  /** The state the source branched from (null = file absent there). */
  baseOid: string | null;
  /** The state the source wants (null = file should be deleted). */
  wantedOid: string | null;
  /** Committed blobs are read from the repo object store by this oid. */
  fromBlobOid: string | null;
  /** Git file mode when known ("100755" ⇒ set the executable bit). */
  wantedMode?: string;
}

/** Committed + worktree changes → the flat set of file ops apply would perform. */
async function buildManifest(changes: BranchChanges, wsCwd: string): Promise<ManifestEntry[]> {
  const out: ManifestEntry[] = [];

  // committed: base state at baseRef, wanted state at HEAD (the work commit(s)).
  if (changes.baseRef && changes.committed.length) {
    const writePaths = changes.committed
      .filter((e) => e.status !== "deleted")
      .flatMap((e) => (e.status === "renamed" && e.oldPath ? [e.path] : [e.path]));
    const baseTree = await treeAt(wsCwd, changes.baseRef, writePaths);
    const headTree = await treeAt(wsCwd, "HEAD", writePaths);
    for (const e of changes.committed) {
      const baseOid = baseTree.get(posix(e.path))?.oid ?? null;
      if (e.status === "deleted") {
        out.push({ path: posix(e.path), action: "delete", status: e.status, group: "committed", baseOid, wantedOid: null, fromBlobOid: null });
      } else if (e.status === "renamed") {
        if (e.oldPath) {
          out.push({ path: posix(e.oldPath), action: "delete", status: e.status, group: "committed", baseOid, wantedOid: null, fromBlobOid: null });
        }
        const entry = headTree.get(posix(e.path));
        out.push({ path: posix(e.path), action: "write", status: e.status, group: "committed", baseOid, wantedOid: entry?.oid ?? null, fromBlobOid: entry?.oid ?? null, wantedMode: entry?.mode });
      } else {
        const entry = headTree.get(posix(e.path));
        out.push({ path: posix(e.path), action: "write", status: e.status, group: "committed", baseOid, wantedOid: entry?.oid ?? null, fromBlobOid: entry?.oid ?? null, wantedMode: entry?.mode });
      }
    }
  }

  // uncommitted: base state = index (HEAD) blob, wanted state = the worktree.
  for (const e of changes.uncommitted) {
    const head = await indexEntry(wsCwd, posix(e.path));
    const baseOid = head?.oid ?? null;
    if (e.status === "deleted") {
      out.push({ path: posix(e.path), action: "delete", status: e.status, group: "uncommitted", baseOid, wantedOid: null, fromBlobOid: null });
    } else {
      const wanted = await worktreeOid(wsCwd, posix(e.path));
      out.push({ path: posix(e.path), action: "write", status: e.status, group: "uncommitted", baseOid, wantedOid: wanted, fromBlobOid: null });
    }
  }

  // untracked: absent at base, wanted state = the worktree.
  for (const e of changes.untracked) {
    const wanted = await worktreeOid(wsCwd, posix(e.path));
    out.push({ path: posix(e.path), action: "write", status: "untracked", group: "untracked", baseOid: null, wantedOid: wanted, fromBlobOid: null });
  }
  return out;
}

// ---- token construction ----

function sourceHashOf(manifest: ManifestEntry[]): string {
  const rows = manifest
    .map((m) => `${m.path}\t${m.action}\t${m.group}\t${m.baseOid ?? "-"}\t${m.wantedOid ?? "-"}`)
    .sort();
  return sha256hex(rows.join("\n"));
}

interface TokenParts {
  taskId: string;
  branchId: string;
  projectId: string;
  sourceWorkspacePath: string;
  baseRef: string | null;
  targetPath: string;
  targetHash: string;
  targetDirty: boolean;
  sourceHash: string;
}

function makeToken(p: TokenParts): string {
  const canonical = JSON.stringify(p);
  return sha256hex(canonical);
}

/**
 * Idempotency key for one apply.
 *
 * The source content (and its base) MUST be part of this key. Keying only on
 * task|branch|target made a SECOND round of work on the same task/branch/target
 * collide with the first operation and be reported as "replayed", so the new
 * change silently never landed — found by an independent re-review probe that
 * applied once, committed more work, and applied again.
 *
 * With sourceHash included:
 *   - the SAME work applied again            -> same id  -> correctly "replayed"
 *   - NEW work on the same task/target       -> new id   -> a real apply
 */
function operationIdFor(
  taskId: string,
  branchId: string,
  targetPath: string,
  sourceHash: string,
  baseRef: string | null
): string {
  return (
    "apply_" +
    sha256hex(`${taskId}|${branchId}|${targetPath}|${sourceHash}|${baseRef ?? ""}`).slice(0, 32)
  );
}

// A short-lived map from confirmToken → the inputs it was computed from, so a
// stale-apply can say WHICH input changed (not just "token invalid"). Bounded by
// TTL; absent in a fresh process, where the message falls back to a fresh preview.
const PREVIEW_TTL_MS = 60 * 60 * 1000;
const previewRegistry = new Map<string, TokenParts & { at: number }>();

function rememberPreview(token: string, parts: TokenParts): void {
  const now = Date.now();
  for (const [k, v] of previewRegistry) if (now - v.at > PREVIEW_TTL_MS) previewRegistry.delete(k);
  previewRegistry.set(token, { ...parts, at: now });
}

function changedInputs(prev: TokenParts, now: TokenParts): string[] {
  const out: string[] = [];
  if (prev.targetHash !== now.targetHash || prev.targetDirty !== now.targetDirty) out.push("目标目录内容");
  if (prev.sourceHash !== now.sourceHash) out.push("源改动");
  if (prev.baseRef !== now.baseRef) out.push("源基准 baseRef");
  if (prev.sourceWorkspacePath !== now.sourceWorkspacePath) out.push("源工作区路径");
  return out;
}

// ---- preview ----

export class ApplyError extends Error {
  constructor(message: string, readonly code: number, readonly detail?: unknown) {
    super(message);
    this.name = "ApplyError";
  }
}

interface ResolveResult {
  targetPath: string;
  targetExists: boolean;
  targetIsGit: boolean;
  targetDirty: boolean;
}

async function resolveTarget(
  svc: DomainService,
  projectId: string,
  explicit: string | null | undefined,
  sourceWsPath: string
): Promise<ResolveResult> {
  const project = svc.getProject(projectId);
  if (!project) throw new ApplyError("project not found", 404);
  const raw = explicit ?? project.rootPath;
  if (!raw) throw new ApplyError("target directory is not defined (no rootPath and no targetPath)", 400);
  const targetPath = resolve(raw);
  if (resolve(sourceWsPath) === targetPath) {
    throw new ApplyError("target directory equals the source workspace", 400);
  }
  const st = await stat(targetPath).catch(() => null);
  if (!st?.isDirectory()) throw new ApplyError("target directory does not exist or is not a directory", 400);

  // A directory stat() can see IS accessible. A non-git target is a legitimate
  // case, not an error: `targetIsGit` exists precisely so the rest of this
  // module can branch on it, and the token/hash code has a bounded-walk path
  // for non-git targets. Throwing "inaccessible" here misdescribed the problem
  // AND made every non-git target (e.g. the P2 notes project) unusable.
  const root = await tryGit(targetPath, ["rev-parse", "--show-toplevel"]).catch(() => null);
  const targetIsGit = typeof root === "string" && root.trim().length > 0;
  if (targetIsGit) {
    const bare = (await tryGit(targetPath, ["rev-parse", "--is-bare-repository"]))?.trim() === "true";
    if (bare) throw new ApplyError("target is a bare repository; refusing to apply", 400);
  }
  return {
    targetPath,
    targetExists: true,
    targetIsGit,
    targetDirty: targetIsGit ? await isDirty(targetPath) : false,
  };
}

/** Shared setup for preview + apply. Throws ApplyError for user-fixable refusals. */
async function prepare(
  svc: DomainService,
  taskId: string,
  explicitTarget: string | null | undefined
): Promise<{
  task: NonNullable<ReturnType<DomainService["getTask"]>>;
  branch: Branch;
  changes: BranchChanges;
  wsCwd: string;
  target: ResolveResult;
  manifest: ManifestEntry[];
  parts: TokenParts;
  operationId: string;
}> {
  const task = svc.getTask(taskId);
  if (!task) throw new ApplyError("task not found", 404);
  if (!task.branchId) throw new ApplyError("task has no branch to apply", 400);
  const branch = svc.getBranch(task.branchId);
  if (!branch) throw new ApplyError("branch not found", 404);
  if (!branch.workspacePath) throw new ApplyError("branch workspace is not bound; nothing to apply", 400);

  const wsCwd = branch.workspacePath;
  const changes = await computeBranchChanges(svc, branch.id);
  if (changes.truncated) {
    throw new ApplyError("change set is truncated; refusing to apply an incomplete set", 409);
  }

  const target = await resolveTarget(svc, task.projectId, explicitTarget, wsCwd);
  const manifest = await buildManifest(changes, wsCwd);
  const targetHash = await targetFingerprint(target.targetPath, target.targetIsGit);

  const parts: TokenParts = {
    taskId: task.id,
    branchId: branch.id,
    projectId: task.projectId,
    sourceWorkspacePath: wsCwd,
    baseRef: changes.baseRef,
    targetPath: target.targetPath,
    targetHash,
    targetDirty: target.targetDirty,
    sourceHash: sourceHashOf(manifest),
  };
  return {
    task,
    branch,
    changes,
    wsCwd,
    target,
    manifest,
    parts,
    // Source content is part of the identity: see operationIdFor's note.
    operationId: operationIdFor(task.id, branch.id, target.targetPath, parts.sourceHash, parts.baseRef),
  };
}

/** Decide apply/skip/conflict for one manifest entry against the live target. */
async function decide(
  entry: ManifestEntry,
  targetDir: string,
  targetIsGit: boolean
): Promise<{ decision: "apply" | "skip" | "conflict"; reason?: string }> {
  const currentOid = await targetFileOid(targetDir, entry.path, targetIsGit);

  if (entry.action === "write") {
    if (currentOid != null && currentOid === entry.wantedOid) {
      return { decision: "skip", reason: "目标文件已是源内容，无需重复应用" };
    }
    if (entry.baseOid == null) {
      // New file in the source: create it if the target lacks it; refuse if the
      // target already has a DIFFERENT file at that path (would be an overwrite).
      if (currentOid == null) return { decision: "apply" };
      return { decision: "conflict", reason: "目标已存在同名文件，源将其视为新增，拒绝覆盖" };
    }
    if (currentOid == null) {
      return { decision: "conflict", reason: "目标文件已被删除，与源基准不一致" };
    }
    if (currentOid !== entry.baseOid) {
      return { decision: "conflict", reason: "目标文件自基准以来已被修改" };
    }
    return { decision: "apply" };
  }

  // delete
  if (currentOid == null) return { decision: "skip", reason: "目标文件已不存在" };
  if (entry.baseOid != null && currentOid !== entry.baseOid) {
    return { decision: "conflict", reason: "目标文件自基准以来已被修改，拒绝删除" };
  }
  if (entry.baseOid == null) {
    return { decision: "conflict", reason: "源未记录该文件基准，拒绝删除目标文件" };
  }
  return { decision: "apply" };
}

export interface PreviewOptions {
  targetPath?: string | null;
}

export async function computeApplyPreview(
  ctx: { svc: DomainService; workspaceManager?: unknown },
  taskId: string,
  opts: PreviewOptions = {}
): Promise<ApplyPreview> {
  const { svc } = ctx;
  const p = await prepare(svc, taskId, opts.targetPath);

  const files: ApplyFileSummary[] = [];
  const conflicts: ApplyConflict[] = [];

  for (const entry of p.manifest) {
    const { decision, reason } = await decide(entry, p.target.targetPath, p.target.targetIsGit);
    if (decision === "conflict") conflicts.push({ path: entry.path, reason: reason ?? "conflict" });
    files.push({
      path: entry.path,
      action: entry.action,
      status: entry.status,
      group: entry.group,
      decision,
      ...(reason ? { reason } : {}),
    });
  }

  const confirmToken = makeToken(p.parts);
  rememberPreview(confirmToken, p.parts);

  return {
    preview: true,
    taskId: p.task.id,
    projectId: p.task.projectId,
    branchId: p.branch.id,
    sourceWorkspacePath: p.wsCwd,
    sourceWorkspaceMode: p.branch.workspaceMode,
    baseRef: p.changes.baseRef,
    sharedWorkspace: p.changes.sharedWorkspace,
    targetPath: p.target.targetPath,
    targetExists: p.target.targetExists,
    targetIsGit: p.target.targetIsGit,
    targetDirty: p.target.targetDirty,
    files,
    conflicts,
    canApply: conflicts.length === 0 && files.some((f) => f.decision === "apply"),
    blocked: null,
    truncated: false,
    operationId: p.operationId,
    confirmToken,
  };
}

// ---- apply ----

interface PreState {
  exists: boolean;
  content: Buffer | null;
  mode: number;
}

export interface ApplyOptions {
  targetPath?: string | null;
  confirmToken: string;
}

/**
 * Execute the apply. Recomputes the token over the CURRENT target; a mismatch is
 * a hard refusal (409) naming which input changed. All writes go through a
 * rollback journal so a mid-apply failure restores the target.
 */
export async function applyTask(
  ctx: { svc: DomainService },
  taskId: string,
  opts: ApplyOptions
): Promise<ApplyResult> {
  const { svc } = ctx;
  const p = await prepare(svc, taskId, opts.targetPath);

  const currentToken = makeToken(p.parts);

  // ── Idempotency first: a repeated click with a token we already applied ──
  const existing = svc.getApplyOperation(p.operationId);

  if (currentToken !== opts.confirmToken) {
    // The token no longer matches the live state. Explain precisely which input
    // changed when we still remember the preview; otherwise return a fresh one.
    const remembered = previewRegistry.get(opts.confirmToken);
    const changed = remembered ? changedInputs(remembered, p.parts) : [];
    // A replayed apply whose target is now exactly the post-apply state would
    // have a different token; the ledger replay above handles the true repeat.
    if (existing && existing.status === "applied" && existing.confirmToken === opts.confirmToken) {
      return replay(existing);
    }
    const detail = {
      changed: changed.length ? changed : ["未知（预览记录已过期或来自其他进程）"],
      conflicts: p.manifest.length ? undefined : undefined,
    };
    throw new ApplyError(
      changed.length
        ? `确认令牌已失效：以下输入自预览后发生变化 —— ${changed.join("、")}；请重新预览后再应用`
        : "确认令牌已失效：目标或源自预览后发生变化；请重新预览后再应用",
      409,
      detail
    );
  }

  // ── Idempotent replay of an already-applied operation ──
  if (existing && existing.status === "applied") return replay(existing);
  if (existing && existing.status === "applying") {
    throw new ApplyError("apply already in progress for this target", 409);
  }

  // Re-decide with the confirmed manifest; a match token means no conflicts, but
  // check anyway (defence in depth — never write over a conflict).
  const ops: ManifestEntry[] = [];
  for (const entry of p.manifest) {
    const { decision } = await decide(entry, p.target.targetPath, p.target.targetIsGit);
    if (decision === "conflict") {
      throw new ApplyError(`目标文件冲突：${entry.path}；应用已拒绝`, 409);
    }
    if (decision === "apply") ops.push(entry);
  }

  // ── ledger row (deterministic id) ──
  if (!existing) {
    try {
      svc.startApplyOperation({
        id: p.operationId,
        taskId: p.task.id,
        projectId: p.task.projectId,
        branchId: p.branch.id,
        targetPath: p.target.targetPath,
        baseRef: p.changes.baseRef,
        confirmToken: opts.confirmToken,
      });
    } catch (err) {
      // Two concurrent applies of the SAME work race between the ledger read
      // above and this insert (there is an await in between). The loser must
      // not surface a raw "already exists" 500: re-read and answer like the
      // sequential case — replay if the winner finished, 409 if still running.
      const raced = svc.getApplyOperation(p.operationId);
      if (raced?.status === "applied") return replay(raced);
      if (raced?.status === "applying") {
        throw new ApplyError("apply already in progress for this target", 409);
      }
      throw err;
    }
  } else {
    // A prior failed/partial attempt on the same deterministic id → retry.
    svc.updateApplyOperation(p.operationId, { status: "applying", applied: [], pending: [], error: null });
  }

  // ── execute with a rollback journal ──
  const journal: { path: string; pre: PreState }[] = [];
  const applied: string[] = [];

  try {
    for (const entry of ops) {
      const abs = resolveInside(p.target.targetPath, entry.path);
      const pre = await readPreState(abs);
      journal.push({ path: entry.path, pre });

      if (entry.action === "delete") {
        await rm(abs, { force: true });
      } else {
        const content = await readWantedContent(entry, p.wsCwd);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, content);
        // Preserve the executable bit for committed blobs.
        if (entry.wantedMode === "100755") await chmodExec(abs);
      }
      applied.push(entry.path);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Roll the already-written files back so the target is unchanged.
    const restore = await rollback(p.target.targetPath, journal);
    const pending = ops.filter((o) => !applied.includes(o.path)).map((o) => o.path);
    const status = restore.ok ? "failed" : "partial";
    svc.updateApplyOperation(p.operationId, {
      status,
      applied,
      pending,
      targetRestored: restore.ok,
      backupDir: null,
      error: restore.ok
        ? `应用中途失败，目标已恢复原状：${message}`
        : `应用中途失败，且无法完全恢复目标：${message}；未恢复项：${restore.failed.join("、")}`,
    });
    return {
      status,
      operationId: p.operationId,
      taskId: p.task.id,
      projectId: p.task.projectId,
      branchId: p.branch.id,
      targetPath: p.target.targetPath,
      baseRef: p.changes.baseRef,
      applied,
      pending,
      targetRestored: restore.ok,
      backupDir: null,
      error: message,
      replayed: false,
    };
  }

  svc.updateApplyOperation(p.operationId, {
    status: "applied",
    applied,
    pending: [],
    targetRestored: true,
    error: null,
  });

  // Provenance: record the applied changeset as an artifact (best-effort — a
  // failed artifact write must not fail an apply that already landed).
  try {
    svc.createArtifact({
      projectId: p.task.projectId,
      originBranchId: p.branch.id,
      originNodeId: p.changes.latestNodeId,
      originTaskId: p.task.id,
      kind: "changeset",
      path: p.target.targetPath,
      summary: `applied ${applied.length} change(s) from branch ${p.branch.id}`,
    });
  } catch {
    /* artifact is provenance, not part of the apply contract */
  }

  return {
    status: "applied",
    operationId: p.operationId,
    taskId: p.task.id,
    projectId: p.task.projectId,
    branchId: p.branch.id,
    targetPath: p.target.targetPath,
    baseRef: p.changes.baseRef,
    applied,
    pending: [],
    targetRestored: true,
    backupDir: null,
    error: null,
    replayed: false,
  };
}

function replay(op: import("@cbw/domain").ApplyOperation): ApplyResult {
  return {
    status: "replayed",
    operationId: op.id,
    taskId: op.taskId,
    projectId: op.projectId,
    branchId: op.branchId,
    targetPath: op.targetPath,
    baseRef: op.baseRef,
    applied: JSON.parse(op.appliedJson) as string[],
    pending: JSON.parse(op.pendingJson) as string[],
    targetRestored: op.targetRestored,
    backupDir: op.backupDir,
    error: op.error,
    replayed: true,
  };
}

async function readPreState(abs: string): Promise<PreState> {
  try {
    const st = await stat(abs);
    if (!st.isFile()) return { exists: false, content: null, mode: 0o644 };
    const content = await readFile(abs);
    return { exists: true, content, mode: st.mode & 0o777 };
  } catch {
    return { exists: false, content: null, mode: 0o644 };
  }
}

async function readWantedContent(entry: ManifestEntry, wsCwd: string): Promise<Buffer> {
  if (entry.group === "committed" && entry.fromBlobOid) {
    return gitBuffer(wsCwd, ["cat-file", "blob", entry.fromBlobOid]);
  }
  return readFile(join(wsCwd, entry.path));
}

async function chmodExec(abs: string): Promise<void> {
  try {
    const { chmod } = await import("node:fs/promises");
    await chmod(abs, 0o755);
  } catch {
    /* executable bit is best-effort; content is what matters */
  }
}

/** Restore every journaled path to its pre-apply state. Reports any failure. */
async function rollback(targetDir: string, journal: { path: string; pre: PreState }[]): Promise<{ ok: boolean; failed: string[] }> {
  const failed: string[] = [];
  for (let i = journal.length - 1; i >= 0; i--) {
    const { path, pre } = journal[i];
    const abs = resolveInside(targetDir, path);
    try {
      if (pre.exists && pre.content != null) {
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, pre.content);
      } else {
        await rm(abs, { force: true });
      }
    } catch {
      failed.push(path);
    }
  }
  return { ok: failed.length === 0, failed };
}
