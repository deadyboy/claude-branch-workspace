// S5 / E8: the project relationship graph (docs/14 §4.4).
//
//   GET /api/projects/:id/graph?depth=N
//     → { nodes, edges, truncated }
//
// SCOPE (docs/14 §4.4, the hard boundary of E8): THREE relationship classes and
// nothing else —
//   1. `contains`   directory containment: project → directories/files, scanned
//                   from the filesystem.
//   2. `executedBy` task → the branch that executes it.
//   3. `produced`   artifact → the turn / branch / task that produced it.
//
// There is deliberately NO code import/call analysis and NO "semantic graph"
// here. The UI must never claim it understands arbitrary code structure, and
// nothing in this module tries to.
//
// Safety lines that the implementation is built around (E8 §5 / brief):
//   * FILE CONTENTS ARE NEVER READ. A filesystem node carries path / type / size
//     only — that is why `readdir`+`stat` are used and `readFile` never is.
//     Credential-looking files are therefore skipped without ever being opened.
//   * NOTHING ESCAPES rootPath. A realpath check refuses entries whose resolved
//     location is outside the project root, so a symlink cannot leak the host
//     filesystem (and cannot leak a credential file reachable through one).
//   * EXCLUSIONS: `.git`, `node_modules`, dependency caches and credential
//     files (`.env*`, `*.pem`, `*.key`, `id_rsa`, …) never appear as nodes.
//   * HONESTY: a file node is `exists`-statically-checked; an artifact-declared
//     path that is not on disk is emitted with `exists: false` (never hidden,
//     never shown as openable). Every edge carries a `provenance`.

import { resolveSafeFile } from "./file-content.js";
import { type Dirent } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  DomainService,
  ProjectGraph,
  ProjectGraphEdge,
  ProjectGraphNode,
} from "@cbw/domain";

// ---- limits (E8 §5 "设合理上限并返回 truncated" ) ----
const DEFAULT_DEPTH = 3;
const MAX_DEPTH = 8;
const MAX_NODES = 2000; // total nodes across all classes
const MAX_DIR_ENTRIES = 500; // entries emitted per directory before deferring

/** Directory names that are never part of the project graph (E8 §4). */
const EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  "bower_components",
  ".pnpm-store",
  ".yarn",
  ".next",
  ".nuxt",
  ".cache",
  ".parcel-cache",
  "__pycache__",
  ".venv",
  "venv",
  "dist",
  "build",
  ".turbo",
  ".pytest_cache",
  ".mypy_cache",
  ".tox",
]);

/**
 * Credential files are EXCLUDED BY NAME, before any read. These are exactly the
 * names a project must never surface; because the scan never opens file
 * contents, skipping them is enough — their bytes are never loaded.
 */
// This module NEVER imports `readFile`: the scan reads directory entries and
// stat metadata only. Credential files are dropped by NAME, so their bytes are
// never loaded even transiently.
const EXCLUDED_FILE_RE = [
  /^\.env(\..*)?$/i, // .env, .env.local, .env.production …
  /^\.envrc$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/i, // OpenSSH private keys
  /\.(pem|key|pfx|p12|keystore|jks)$/i, // private keys / keystores
  /^\.netrc$/i,
  /^\.npmrc$/i,
  /^\.pgpass$/i,
  /^\.htpasswd$/i,
  /^credentials(\.json)?$/i, // aws style
  /^secrets?\.(json|ya?ml|toml)$/i,
];

// The exact substring that tells a caller this file was not read; asserted by
// the leak tests (the key name is reported, the contents never are).
function isExcludedFile(name: string): boolean {
  return EXCLUDED_FILE_RE.some((re) => re.test(name));
}

/** Relative path → posix separators (git/windows-agnostic identity). */
const toPosix = (p: string): string => p.split(sep).join("/");

/** True when `abs` is `root` itself or lives underneath it (no `..` escape). */
function isInside(root: string, abs: string): boolean {
  return abs === root || abs.startsWith(root + sep);
}

function clampDepth(raw: number | undefined): number {
  const n = raw ?? DEFAULT_DEPTH;
  if (!Number.isFinite(n) || n < 0) return DEFAULT_DEPTH;
  return Math.min(Math.floor(n), MAX_DEPTH);
}

// ---- filesystem containment scan (E8 relationship class 1) ----

interface ScanResult {
  nodes: ProjectGraphNode[];
  edges: ProjectGraphEdge[];
  truncated: boolean;
}

/**
 * Scan `rootPath` breadth-first to `depth` levels. Directories and files become
 * nodes; each becomes the target of a `contains` edge from its parent (the
 * project node for depth 1). Never opens a file.
 */
async function scanContainment(
  projectId: string,
  rootPath: string,
  depth: number,
  budget: { nodes: number; truncated: boolean }
): Promise<ScanResult> {
  const nodes: ProjectGraphNode[] = [];
  const edges: ProjectGraphEdge[] = [];

  // Resolve the root once. A symlinked root is allowed (the user chose it), but
  // every entry below is checked against this resolved root.
  let realRoot: string;
  try {
    realRoot = await realpath(rootPath);
  } catch {
    return { nodes, edges, truncated: false };
  }

  const rootId = `project:${projectId}`;

  interface QueueItem {
    abs: string; // resolved absolute directory
    parentNodeId: string; // id of the node this directory hangs under
    rel: string; // posix path relative to root ("" for root itself)
    level: number; // 1 = direct child of root
  }

  const queue: QueueItem[] = [{ abs: realRoot, parentNodeId: rootId, rel: "", level: 1 }];

  while (queue.length) {
    const cur = queue.shift()!;
    if (budget.nodes >= MAX_NODES) {
      budget.truncated = true;
      break;
    }

    // The directory's own node. The root is the project node, so it is only
    // created for subdirectories.
    let dirParentId = cur.parentNodeId;
    if (cur.rel) {
      const id = `dir:${cur.rel}`;
      if (!nodes.some((n) => n.id === id)) {
        nodes.push({
          id,
          kind: "directory",
          label: basename(cur.abs),
          projectId,
          path: cur.rel,
        });
        budget.nodes++;
      }
      edges.push({
        id: `contains:${cur.parentNodeId}->${id}`,
        kind: "contains",
        source: cur.parentNodeId,
        target: id,
        provenance: "filesystem",
      });
      dirParentId = id;
    }

    let entries: Dirent[];
    try {
      entries = await readdir(cur.abs, { withFileTypes: true });
    } catch {
      continue; // unreadable directory: skip, never throw (E8 robustness)
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    let emitted = 0;
    for (const e of entries) {
      if (budget.nodes >= MAX_NODES) {
        budget.truncated = true;
        break;
      }
      if (emitted >= MAX_DIR_ENTRIES) {
        // The directory has more children than we will enumerate at this level.
        budget.truncated = true;
        markDirTruncated(nodes, dirParentId);
        break;
      }

      const childAbs = join(cur.abs, e.name);
      const childRel = cur.rel ? `${cur.rel}/${e.name}` : e.name;

      // Prefer the entry type; fall back to lstat for a symlink/other.
      let kind: "dir" | "file" | "other" = e.isDirectory()
        ? "dir"
        : e.isFile()
        ? "file"
        : "other";
      if (kind === "other") {
        const st = await lstat(childAbs).catch(() => null);
        if (!st) continue;
        if (st.isSymbolicLink()) {
          // Decide a symlink's target type WITHOUT following it out of bounds.
          const linkTarget = await stat(childAbs).catch(() => null);
          if (!linkTarget) continue; // dangling
          kind = linkTarget.isDirectory() ? "dir" : linkTarget.isFile() ? "file" : "other";
          if (kind === "other") continue;
        } else if (st.isDirectory()) {
          kind = "dir";
        } else if (st.isFile()) {
          kind = "file";
        } else {
          continue;
        }
      }

      if (kind === "dir") {
        if (EXCLUDED_DIRS.has(e.name)) continue; // .git, node_modules, caches …
        // A symlinked directory must still resolve inside root (no escape).
        const real = await realpath(childAbs).catch(() => null);
        if (!real || !isInside(realRoot, real)) continue;
        if (cur.level >= depth) {
          // Emit the directory (so it is visible) but do not descend.
          const id = `dir:${childRel}`;
          if (!nodes.some((n) => n.id === id)) {
            nodes.push({ id, kind: "directory", label: e.name, projectId, path: childRel, truncated: true });
            budget.nodes++;
            emitted++;
          }
          edges.push({
            id: `contains:${dirParentId}->${id}`,
            kind: "contains",
            source: dirParentId,
            target: id,
            provenance: "filesystem",
          });
          budget.truncated = true; // we stopped before fully exploring
          continue;
        }
        queue.push({ abs: real, parentNodeId: dirParentId, rel: childRel, level: cur.level + 1 });
        continue;
      }

      // File (or symlink to a file): never open it, never read it.
      if (isExcludedFile(e.name)) continue; // credential files skipped by NAME

      // A symlink to a file must resolve inside root too.
      if (e.isSymbolicLink()) {
        const real = await realpath(childAbs).catch(() => null);
        if (!real || !isInside(realRoot, real)) continue;
        // If the resolved target is a directory, defer it to the dir branch.
      } else {
        const real = resolve(childAbs);
        if (!isInside(realRoot, real)) continue;
      }

      const st = await stat(childAbs).catch(() => null);
      const fileId = `file:${childRel}`;
      if (!nodes.some((n) => n.id === fileId)) {
        nodes.push({
          id: fileId,
          kind: "file",
          label: e.name,
          projectId,
          path: childRel,
          exists: st?.isFile() ?? false,
          ...(st?.isFile() ? { sizeBytes: st.size } : {}),
        });
        budget.nodes++;
        emitted++;
      }
      edges.push({
        id: `contains:${dirParentId}->${fileId}`,
        kind: "contains",
        source: dirParentId,
        target: fileId,
        provenance: "filesystem",
      });
    }
  }

  return { nodes, edges, truncated: false };
}

function markDirTruncated(nodes: ProjectGraphNode[], id: string): void {
  const n = nodes.find((x) => x.id === id);
  if (n) n.truncated = true;
}

// ---- domain relationship classes 2 & 3 ----

/**
 * task → branch (`executedBy`) and artifact → origin (`produced`). Only edges
 * whose endpoints exist in the project are emitted, and each carries the exact
 * provenance field it was read from.
 */
function buildDomainRelations(
  svc: DomainService,
  projectId: string,
  branchIds: ReadonlySet<string>,
  budget: { nodes: number; truncated: boolean }
): { nodes: ProjectGraphNode[]; edges: ProjectGraphEdge[] } {
  const nodes: ProjectGraphNode[] = [];
  const edges: ProjectGraphEdge[] = [];
  const seen = new Set<string>();

  const addNode = (n: ProjectGraphNode): void => {
    if (seen.has(n.id)) return;
    if (budget.nodes >= MAX_NODES) {
      budget.truncated = true;
      return;
    }
    seen.add(n.id);
    nodes.push(n);
    budget.nodes++;
  };

  // does a turn belong to this project's branch set? (used to gate provenance)
  const turnInProject = (turnId: string): boolean => {
    const t = svc.getNode(turnId);
    return Boolean(t && branchIds.has(t.branchId));
  };

  // ---- task execution relationship ----
  for (const task of svc.listTasksByProject(projectId)) {
    addNode({
      id: `task:${task.id}`,
      kind: "task",
      label: task.title,
      projectId,
      taskId: task.id,
      status: task.status,
    });
    if (task.branchId && branchIds.has(task.branchId)) {
      edges.push({
        id: `executedBy:${task.id}->${task.branchId}`,
        kind: "executedBy",
        source: `task:${task.id}`,
        target: `branch:${task.branchId}`,
        provenance: "task.branchId",
      });
    }
  }

  // ---- artifact provenance relationship ----
  for (const artifact of svc.listArtifacts(projectId)) {
    addNode({
      id: `artifact:${artifact.id}`,
      kind: "artifact",
      label: artifact.summary ?? `${artifact.kind} ${artifact.id.slice(0, 8)}`,
      projectId,
      artifactId: artifact.id,
      status: artifact.kind,
      ...(artifact.path ? { path: artifact.path } : {}),
    });

    // Branch origin: keep in sight even when no turn/time link is derivable.
    if (artifact.originBranchId && branchIds.has(artifact.originBranchId)) {
      edges.push({
        id: `produced:${artifact.originBranchId}->${artifact.id}`,
        kind: "produced",
        source: `branch:${artifact.originBranchId}`,
        target: `artifact:${artifact.id}`,
        provenance: "artifact.originBranchId",
      });
    }
    // Task origin.
    if (artifact.originTaskId) {
      const t = svc.getTask(artifact.originTaskId);
      if (t && t.projectId === projectId) {
        addNode({
          id: `task:${t.id}`,
          kind: "task",
          label: t.title,
          projectId,
          taskId: t.id,
          status: t.status,
        });
        edges.push({
          id: `produced:${artifact.originTaskId}->${artifact.id}`,
          kind: "produced",
          source: `task:${artifact.originTaskId}`,
          target: `artifact:${artifact.id}`,
          provenance: "artifact.originTaskId",
        });
      }
    }
    // Turn origin: decided from the node itself, so we never invent a link.
    if (artifact.originNodeId && turnInProject(artifact.originNodeId)) {
      const turn = svc.getNode(artifact.originNodeId)!;
      addNode({
        id: `turn:${turn.id}`,
        kind: "turn",
        label: `Turn ${turn.localTurnIndex + 1}`,
        projectId,
        branchId: turn.branchId,
        nodeId: turn.id,
        status: turn.status,
      });
      edges.push({
        id: `produced:turn:${turn.id}->${artifact.id}`,
        kind: "produced",
        source: `turn:${turn.id}`,
        target: `artifact:${artifact.id}`,
        provenance: "artifact.originNodeId",
      });
    }
  }

  return { nodes, edges };
}

/**
 * A file node for every artifact `path`, stat-checked against rootPath. A path
 * that is missing, outside the root, or a credential file still yields a node
 * with `exists: false` (so the UI shows the CURRENT state, never a fake open
 * button) but is NEVER read. Ids match the containment scan's `file:<rel>` so a
 * present file is the SAME node in both views.
 */
async function buildArtifactFileNodes(
  projectId: string,
  rootPath: string | null,
  artifacts: { id: string; path: string | null; branchId: string | null; rootPath: string | null; workspaceMode?: string }[],
  budget: { nodes: number; truncated: boolean },
  existing: Set<string>
): Promise<{ nodes: ProjectGraphNode[]; edges: ProjectGraphEdge[] }> {
  const nodes: ProjectGraphNode[] = [];
  const edges: ProjectGraphEdge[] = [];
  if (!rootPath) return { nodes, edges };

  let realRoot: string;
  try {
    realRoot = await realpath(rootPath);
  } catch {
    return { nodes, edges };
  }

  for (const a of artifacts) {
    if (!a.path) continue;
    const root = a.rootPath ?? (a.workspaceMode === "worktree" ? null : rootPath);
    const branchFile = a.branchId && (a.workspaceMode === "worktree" || root !== rootPath) ? a.branchId : null;
    let checked: Awaited<ReturnType<typeof resolveSafeFile>> | null = null;
    try { if (root) checked = await resolveSafeFile(root, a.path); } catch { /* unavailable or protected: no open button */ }
    const rel = checked?.path ?? toPosix(a.path);
    const fileId = branchFile ? `file:branch:${branchFile}:${rel}` : `file:${rel}`;
    const exists = checked?.exists ?? false;
    const sizeBytes = checked?.exists ? checked.sizeBytes : undefined;

    if (!existing.has(fileId)) {
      if (budget.nodes >= MAX_NODES) {
        budget.truncated = true;
        continue;
      }
      existing.add(fileId);
      nodes.push({
        id: fileId,
        kind: "file",
        label: basename(a.path),
        projectId,
        path: rel,
        ...(branchFile ? { branchId: branchFile } : {}),
        exists,
        ...(sizeBytes != null ? { sizeBytes } : {}),
      });
      budget.nodes++;
    }

    // artifact → file ("this result is a file at this path").
    edges.push({
      id: `produced:${a.id}->${fileId}`,
      kind: "produced",
      source: `artifact:${a.id}`,
      target: fileId,
      provenance: "artifact.path",
    });
  }
  return { nodes, edges };
}

// ---- entrypoint ----

export interface BuildGraphOptions {
  /** Layers of directory containment to expand (clamped to [0, MAX_DEPTH]). */
  depth?: number;
}

/**
 * Build the E8 project relationship graph. Total `truncated` is true when ANY
 * class hit a limit (depth cut, node cap, entry cap) — never a silent omission.
 */
export async function buildProjectGraph(
  svc: DomainService,
  projectId: string,
  opts: BuildGraphOptions = {}
): Promise<ProjectGraph> {
  const project = svc.getProject(projectId);
  if (!project) throw new Error(`project ${projectId} not found`);

  const depth = clampDepth(opts.depth);
  const budget = { nodes: 0, truncated: false };

  // Project node (always present — it is the root of the containment edges).
  const nodes: ProjectGraphNode[] = [
    { id: `project:${projectId}`, kind: "project", label: project.name, projectId },
  ];
  budget.nodes = 1;

  const branches = svc.listBranches(projectId);

  // Domain relations first (cheap, no filesystem) so their nodes are not cut by
  // a large directory scan.
  const domain = buildDomainRelations(svc, projectId, new Set(branches.map((b) => b.id)), budget);
  nodes.push(...domain.nodes);

  const edges: ProjectGraphEdge[] = [];
  edges.push(...domain.edges);

  // depth 0 = no directory expansion at all; report it as truncated (there IS
  // more content the caller chose not to see) rather than pretending the project
  // is empty.

  // Branch nodes: referenced by executedBy AND needed by the UI to open a branch
  // from a task or an artifact. (Only branches of THIS project.)
  for (const b of branches) {
    if (budget.nodes >= MAX_NODES) {
      budget.truncated = true;
      break;
    }
    nodes.push({
      id: `branch:${b.id}`,
      kind: "branch",
      label: b.displayName ?? "(unnamed)",
      projectId,
      branchId: b.id,
      status: b.status,
    });
    budget.nodes++;
  }

  // Artifact → file nodes (stat-checked; never read).
  const artifacts = svc.listArtifacts(projectId);
  const fileIds = new Set<string>(nodes.filter((n) => n.kind === "file").map((n) => n.id));
  const artifactFiles = await buildArtifactFileNodes(
    projectId,
    project.rootPath,
    artifacts.map((a) => ({ id: a.id, path: a.path, branchId: a.originBranchId, rootPath: a.originBranchId ? svc.getBranch(a.originBranchId)?.workspacePath ?? null : null, workspaceMode: a.originBranchId ? svc.getBranch(a.originBranchId)?.workspaceMode : undefined })),
    budget,
    fileIds
  );
  nodes.push(...artifactFiles.nodes);
  edges.push(...artifactFiles.edges);

  // Directory containment (heaviest last).
  if (project.rootPath && depth > 0) {
    const scan = await scanContainment(projectId, project.rootPath, depth, budget);
    nodes.push(...scan.nodes);
    edges.push(...scan.edges);
    if (scan.truncated) budget.truncated = true;
  } else if (project.rootPath) {
    budget.truncated = true; // depth 0: not expanded on purpose
  }

  const unique = [...new Map(nodes.map(n => [n.id, n])).values()];
  const ids = new Set(unique.map(n => n.id));
  const validEdges = [...new Map(edges.filter(e => ids.has(e.source) && ids.has(e.target)).map(e => [e.id, e])).values()];
  return { nodes: unique, edges: validEdges, truncated: budget.truncated };
}
