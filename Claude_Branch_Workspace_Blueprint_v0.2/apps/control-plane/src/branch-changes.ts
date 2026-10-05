// S3 / E4a: the read-only result review (docs/14 §4.2).
//
// The one requirement the freeze calls out loudly: the response MUST include
// committed AND uncommitted AND untracked. A `git diff` alone silently drops
// commits an agent made during its run, so `committed` is computed from
// `baseRef..HEAD` (the commits themselves), `uncommitted` from the working tree
// versus HEAD, and `untracked` from `git ls-files --others`.
//
// Honesty rules baked in here:
//   * binary files get `patch: null` (name/size only) — contents are never
//     diffed. Binary is detected from `git diff --numstat` ("-" means binary)
//     for tracked files and from a NUL-byte sniff for untracked ones.
//   * a shared workspace may be written by OTHER branches, so its diffs are
//     reported as workspace changes — `sharedWorkspace` carries that caveat and
//     the origin is NEVER claimed as this branch's exclusive artifact.
//   * a non-Git or unbound workspace returns an honest empty result, never 500.
//
// The whole workspace's `base_ref` may be null (shared non-Git folder, or a
// branch bound before S3); committed is then empty and only working-tree /
// untracked changes are reported.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { open, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BranchChanges, ChangeEntry, ChangeStatus, DomainService } from "@cbw/domain";

const exec = promisify(execFile);

// Same invocation shape as WorkspaceManager / project-capabilities: execFile +
// windowsHide. maxBuffer is generous for diffs but bounded, so a pathological
// change set degrades to `truncated: true` instead of OOM.
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, ...args], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

// Never throws: a failed git read degrades to empty (and the caller/`truncated`
// signal handles it) rather than surfacing a 500.
async function tryGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    return await git(cwd, args);
  } catch {
    return null;
  }
}

const MAX_ENTRIES = 500; // per group
const MAX_PATCH_BYTES = 64 * 1024; // per file
const MAX_BINARY_SIZE_LOOKUPS = 200; // bound the per-file `cat-file -s` fan-out

// ---- git output parsers (both use -z: NUL-separated, no quoting surprises) ----

/** `git diff --name-status -z -M` → status/path (+oldPath for renames). */
function parseNameStatusZ(out: string): { status: ChangeStatus; path: string; oldPath?: string }[] {
  const toks = out.split("\0");
  const res: { status: ChangeStatus; path: string; oldPath?: string }[] = [];
  let i = 0;
  while (i < toks.length) {
    const code = toks[i++];
    if (!code) continue;
    const c = code[0];
    let path: string;
    let oldPath: string | undefined;
    if (c === "R" || c === "C") {
      oldPath = toks[i++];
      path = toks[i++];
    } else {
      path = toks[i++];
    }
    if (!path) continue;
    res.push({ status: mapStatus(c), path, oldPath: oldPath || undefined });
  }
  return res;
}

function mapStatus(c: string): ChangeStatus {
  switch (c) {
    case "A": return "added";
    case "D": return "deleted";
    case "R": return "renamed";
    default: return "modified"; // M, C, T (type change), U (unmerged), X
  }
}

/**
 * `git diff --numstat --no-renames -z` → per-path add/delete counts. In -z mode
 * a rename record is "<a>\t<d>\t\0<old>\0<new>\0" (empty path field), which we
 * re-join here. Binary files come back as "-\t-".
 */
function parseNumstatZ(out: string): { path: string; binary: boolean }[] {
  const toks = out.split("\0");
  const res: { path: string; binary: boolean }[] = [];
  let i = 0;
  while (i < toks.length) {
    const head = toks[i++];
    if (!head) continue;
    const parts = head.split("\t");
    if (parts.length < 3) continue;
    const added = parts[0];
    const deleted = parts[1];
    let path = parts.slice(2).join("\t");
    if (path === "") {
      // rename: next two NUL tokens are old then new
      i++; // old
      path = toks[i++];
    }
    if (!path) continue;
    res.push({ path, binary: added === "-" || deleted === "-" });
  }
  return res;
}

/** Split a combined diff into per-file blocks keyed by the NEW path (b/…). */
function splitPatchByPath(diffText: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!diffText) return map;
  for (const part of diffText.split(/(?=^diff --git )/m)) {
    if (!part.startsWith("diff --git ")) continue;
    const nl = part.indexOf("\n");
    const header = (nl >= 0 ? part.slice(0, nl) : part).replace(/\r$/, "");
    const idx = header.lastIndexOf(" b/");
    if (idx < 0) continue;
    let p = header.slice(idx + 3);
    // git quotes unusual names; unwrap when present, else use as-is.
    if (p.startsWith('"') && p.endsWith('"')) {
      try { p = JSON.parse(p); } catch { /* keep raw */ }
    }
    map.set(p, part);
  }
  return map;
}

function capPatch(patch: string | undefined): { patch: string | null; truncated: boolean } {
  if (!patch) return { patch: null, truncated: false };
  if (patch.length > MAX_PATCH_BYTES) {
    return { patch: `${patch.slice(0, MAX_PATCH_BYTES)}\n… (patch truncated)`, truncated: true };
  }
  return { patch, truncated: false };
}

// ---- filesystem probes ----

async function workingSize(cwd: string, rel: string): Promise<number | undefined> {
  try {
    const s = await stat(join(cwd, rel));
    return s.isFile() ? s.size : undefined;
  } catch {
    return undefined;
  }
}

/** Byte size of a committed blob at `rev` (used for binary size hints). */
async function blobSize(cwd: string, rev: string, rel: string): Promise<number | undefined> {
  const out = await tryGit(cwd, ["cat-file", "-s", `${rev}:${rel}`]);
  if (out == null) return undefined;
  const n = Number(out.trim());
  return Number.isFinite(n) ? n : undefined;
}

/** git's own heuristic: a NUL byte in the first 8000 bytes means binary. */
async function sniffBinary(cwd: string, rel: string): Promise<boolean> {
  try {
    const fh = await open(join(cwd, rel), "r");
    try {
      const buf = Buffer.alloc(8000);
      const { bytesRead } = await fh.read(buf, 0, 8000, 0);
      return buf.subarray(0, bytesRead).includes(0);
    } finally {
      await fh.close();
    }
  } catch {
    return false;
  }
}

/** A readable "new file" patch for a text untracked file (no index baseline). */
async function untrackedPatch(cwd: string, rel: string): Promise<{ patch: string | null; truncated: boolean }> {
  try {
    const content = await readFile(join(cwd, rel), "utf8");
    const truncated = content.length > MAX_PATCH_BYTES;
    const body = truncated ? content.slice(0, MAX_PATCH_BYTES) : content;
    const lines = body.split(/\r?\n/);
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    const header = `diff --git a/${rel} b/${rel}\nnew file mode 100644\n--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${lines.length} @@\n`;
    const patch = header + lines.map((l) => `+${l}`).join("\n") + "\n" + (truncated ? "… (patch truncated)\n" : "");
    return { patch, truncated };
  } catch {
    return { patch: null, truncated: false };
  }
}

/** Most recent COMPLETED turn of the branch → the "来源轮次" (E4a). */
function latestCompletedNodeId(svc: DomainService, branchId: string): string | null {
  let n = svc.lastNode(branchId);
  const seen = new Set<string>();
  while (n && !seen.has(n.id)) {
    seen.add(n.id);
    if (n.status === "completed") return n.id;
    n = n.parentNodeId ? svc.getNode(n.parentNodeId) : null;
  }
  return null;
}

/**
 * Compute the read-only change set for a branch (docs/14 §4.2). Never throws
 * for a normal "nothing to report" case (unbound / non-Git workspace).
 */
export async function computeBranchChanges(svc: DomainService, branchId: string): Promise<BranchChanges> {
  const branch = svc.getBranch(branchId);
  if (!branch) throw new Error("branch not found");

  const cwd = branch.workspacePath;
  const result: BranchChanges = {
    baseRef: branch.baseRef,
    workspacePath: cwd,
    workspaceMode: branch.workspaceMode,
    committed: [],
    uncommitted: [],
    untracked: [],
    truncated: false,
    projectId: branch.projectId,
    branchId: branch.id,
    latestNodeId: latestCompletedNodeId(svc, branchId),
    sourceBranchId: branch.parentBranchId,
    // A shared directory is, by definition, not exclusive: report its diffs as
    // workspace changes, never as this branch's own artifact (E4a honesty rule).
    sharedWorkspace: branch.workspaceMode === "shared",
  };

  if (!cwd) return result; // unbound branch: nothing to review yet

  const inside = await tryGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside == null) return result; // not a Git workspace (plain folder)

  let truncated = false;

  // ---- committed: baseRef..HEAD (commits made DURING the work) ----
  if (branch.baseRef) {
    const range = `${branch.baseRef}..HEAD`;
    const ns = parseNameStatusZ((await tryGit(cwd, ["diff", "--name-status", "-z", "-M", range])) ?? "");
    const numByPath = new Map(parseNumstatZ((await tryGit(cwd, ["diff", "--numstat", "--no-renames", "-z", range])) ?? "").map((n) => [n.path, n]));
    const diffText = await tryGit(cwd, ["diff", "-M", range]);
    if (ns.length && diffText == null) truncated = true; // diff too large / unreadable
    const patchByPath = diffText ? splitPatchByPath(diffText) : new Map<string, string>();

    let entries: ChangeEntry[] = [];
    let binLookups = 0;
    for (const r of ns) {
      const binary = numByPath.get(r.path)?.binary ?? false;
      let sizeBytes: number | undefined;
      if (binary && r.status !== "deleted" && binLookups < MAX_BINARY_SIZE_LOOKUPS) {
        sizeBytes = await blobSize(cwd, "HEAD", r.path);
        binLookups++;
      }
      const built = buildEntry(r.status, r.path, r.oldPath, binary, sizeBytes, binary ? undefined : patchByPath.get(r.path));
      if (built.truncated) truncated = true;
      entries.push(built.entry);
    }
    if (entries.length > MAX_ENTRIES) {
      entries = entries.slice(0, MAX_ENTRIES);
      truncated = true;
    }
    result.committed = entries;
  }

  // ---- uncommitted: working tree + index vs HEAD (staged AND unstaged) ----
  // Using `HEAD` (not a bare `git diff`) so a merely-staged change is not lost
  // between "committed" and "untracked" — the E4a "无遗漏" requirement.
  {
    const ns = parseNameStatusZ((await tryGit(cwd, ["diff", "--name-status", "-z", "-M", "HEAD"])) ?? "");
    const numByPath = new Map(parseNumstatZ((await tryGit(cwd, ["diff", "--numstat", "--no-renames", "-z", "HEAD"])) ?? "").map((n) => [n.path, n]));
    const diffText = await tryGit(cwd, ["diff", "-M", "HEAD"]);
    if (ns.length && diffText == null) truncated = true;
    const patchByPath = diffText ? splitPatchByPath(diffText) : new Map<string, string>();

    let entries: ChangeEntry[] = [];
    for (const r of ns) {
      const binary = numByPath.get(r.path)?.binary ?? false;
      const sizeBytes =
        binary && r.status !== "deleted" ? await workingSize(cwd, r.path) : undefined;
      const built = buildEntry(r.status, r.path, r.oldPath, binary, sizeBytes, binary ? undefined : patchByPath.get(r.path));
      if (built.truncated) truncated = true;
      entries.push(built.entry);
    }
    if (entries.length > MAX_ENTRIES) {
      entries = entries.slice(0, MAX_ENTRIES);
      truncated = true;
    }
    result.uncommitted = entries;
  }

  // ---- untracked: files git does not track yet ----
  {
    const out = (await tryGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])) ?? "";
    const paths = out.split("\0").filter(Boolean);
    let entries: ChangeEntry[] = [];
    for (const path of paths) {
      const binary = await sniffBinary(cwd, path);
      const sizeBytes = binary ? await workingSize(cwd, path) : undefined;
      if (binary) {
        entries.push({ path, status: "untracked", binary: true, ...(sizeBytes != null ? { sizeBytes } : {}), patch: null });
      } else {
        const { patch, truncated: t } = await untrackedPatch(cwd, path);
        if (t) truncated = true;
        entries.push({ path, status: "untracked", binary: false, patch });
      }
    }
    if (entries.length > MAX_ENTRIES) {
      entries = entries.slice(0, MAX_ENTRIES);
      truncated = true;
    }
    result.untracked = entries;
  }

  result.truncated = truncated;
  return result;
}

function buildEntry(
  status: ChangeStatus,
  path: string,
  oldPath: string | undefined,
  binary: boolean,
  sizeBytes: number | undefined,
  rawPatch: string | undefined
): { entry: ChangeEntry; truncated: boolean } {
  const { patch, truncated } = binary ? { patch: null as string | null, truncated: false } : capPatch(rawPatch);
  const entry: ChangeEntry = {
    path,
    status,
    ...(oldPath ? { oldPath } : {}),
    binary,
    ...(sizeBytes != null ? { sizeBytes } : {}),
    patch,
  };
  return { entry, truncated };
}
