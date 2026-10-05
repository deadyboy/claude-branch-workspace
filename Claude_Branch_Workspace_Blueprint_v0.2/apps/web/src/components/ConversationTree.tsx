// Left pane: the persistent Conversation Tree (constitution two-tree
// separation). Renders branches NESTED under the branch they forked from, so
// the fork relationship is visible without opening the graph view — this is the
// core difference from a flat session list (docs/02).
//
// Identity is always the immutable id: display names may repeat, so every row
// shows a short id and the tree never merges two same-named branches.

import { useEffect, useMemo, useState } from "react";
import { useStore, branchBusy, branchLastNode } from "../store/useStore";
import { api } from "../api/client";
import { ForkDialog } from "./ForkDialog";
import type { Branch } from "../types";

function shortId(id: string): string {
  return id.slice(0, 4);
}

function branchStatus(branch: Branch): "running" | "attention" | "error" | "idle" {
  const s = useStore.getState();
  if (branchBusy(s, branch.id)) return "running";
  const last = branchLastNode(s, branch.id);
  if (last?.status === "failed") return "error";
  const attn = s.attention.find((c) => c.branchId === branch.id && c.status === "pending");
  if (attn) return "attention";
  return "idle";
}

interface TreeRow {
  branch: Branch;
  depth: number;
  /** The turn this branch forked from, when it is a fork. */
  forkFrom: string | null;
}

/**
 * Nest branches under their parent so ancestry is visible at a glance. Depth is
 * derived from the persisted parent chain ONLY — never from render order — so a
 * later layout change cannot silently rewrite genealogy (docs/14 §2.3.2).
 */
function buildRows(branches: Branch[], needle: string, activeOnly: boolean): TreeRow[] {
  const byParent = new Map<string | null, Branch[]>();
  for (const b of branches) {
    const key = b.parentBranchId ?? null;
    const list = byParent.get(key) ?? [];
    list.push(b);
    byParent.set(key, list);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  const rows: TreeRow[] = [];
  const seen = new Set<string>();

  const matches = (b: Branch): boolean => {
    if (!needle) return true;
    return [b.displayName ?? "", b.id, b.workspacePath ?? ""]
      .some((v) => v.toLocaleLowerCase().includes(needle));
  };

  // A branch is shown when it matches, or when any descendant matches (so a
  // filtered search still shows the ancestry path that gives it meaning).
  const visibleCache = new Map<string, boolean>();
  const isVisible = (b: Branch): boolean => {
    const cached = visibleCache.get(b.id);
    if (cached !== undefined) return cached;
    const self = matches(b);
    const kids = (byParent.get(b.id) ?? []).some(isVisible);
    const result = self || kids;
    visibleCache.set(b.id, result);
    return result;
  };

  function walk(parentId: string | null, depth: number): void {
    for (const b of byParent.get(parentId) ?? []) {
      if (seen.has(b.id)) continue; // defensive against a malformed cycle
      if (!isVisible(b)) continue;
      if (activeOnly && b.status !== "active" && !(byParent.get(b.id) ?? []).length) continue;
      seen.add(b.id);
      rows.push({ branch: b, depth, forkFrom: b.forkFromNodeId });
      walk(b.id, depth + 1);
    }
  }
  walk(null, 0);

  // Anything unreachable from a root (archived orphan from a deleted parent)
  // still needs to render rather than vanish from the UI.
  for (const b of branches) {
    if (seen.has(b.id)) continue;
    if (!isVisible(b)) continue;
    rows.push({ branch: b, depth: 0, forkFrom: b.forkFromNodeId });
    seen.add(b.id);
  }
  return rows;
}

export function ConversationTree() {
  const states = useStore();
  const activeBranchId = states.activeBranchId;
  const all = states.branches;
  const [search, setSearch] = useState("");
  const [activeOnly, setActiveOnly] = useState(true);
  const [visibleLimit, setVisibleLimit] = useState(BRANCH_PAGE_SIZE);

  useEffect(() => {
    setVisibleLimit(BRANCH_PAGE_SIZE);
  }, [search, activeOnly]);

  const rows = useMemo(() => buildRows(all, search.trim().toLocaleLowerCase(), activeOnly), [all, search, activeOnly]);
  const visible = rows.slice(0, visibleLimit);

  return (
    <aside className="pane tree">
      <div className="pane-hd">
        <span>Conversation Tree</span>
        <span className="badge subtle">Shared / Worktree</span>
      </div>
      <div className="tree-filters">
        <label className="tree-search">
          <span className="sr-only">Search branches</span>
          <input
            aria-label="Search branches"
            type="text"
            value={search}
            placeholder="Search branches…"
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <label className="active-filter">
          <input
            aria-label="Active branches only"
            type="checkbox"
            checked={activeOnly}
            onChange={(event) => setActiveOnly(event.target.checked)}
          />
          Active only
        </label>
        <span className="tree-count">{visible.length} / {rows.length}</span>
      </div>
      <div className="tree-list" data-testid="conversation-tree">
        {visible.map((row) => (
          <BranchRow
            key={row.branch.id}
            branch={row.branch}
            active={row.branch.id === activeBranchId}
            depth={row.depth}
            forkFrom={row.forkFrom}
            muted={row.branch.status === "archived"}
          />
        ))}
        {rows.length === 0 && <div className="empty">No matching branches</div>}
      </div>
      {visible.length < rows.length && (
        <button className="tree-more" onClick={() => setVisibleLimit((limit) => limit + BRANCH_PAGE_SIZE)}>
          Show more ({rows.length - visible.length} remaining)
        </button>
      )}
    </aside>
  );
}

const BRANCH_PAGE_SIZE = 50;

function BranchRow({
  branch,
  active,
  depth,
  forkFrom,
  muted = false,
}: {
  branch: Branch;
  active: boolean;
  depth: number;
  forkFrom: string | null;
  muted?: boolean;
}) {
  const st = useStore();
  const [showFork, setShowFork] = useState(false);
  const busy = branchBusy(st, branch.id);
  const last = branchLastNode(st, branch.id);
  const status = branchStatus(branch);

  const activate = () => {
    st.setActiveBranch(branch.id);
  };

  const archive = async () => {
    if (!confirm(`Archive branch "${branch.displayName ?? branch.id}"?`)) return;
    try {
      await api.archiveBranch(branch.id);
      const refreshed = await api.listBranches(branch.projectId);
      st.setBranches(refreshed);
    } catch (e) {
      alert(String(e instanceof Error ? e.message : e));
    }
  };

  return (
    <div
      className={`tree-row ${active ? "active" : ""} ${muted ? "muted" : ""}`}
      // Depth is a visual indent derived from persisted ancestry only.
      style={{ paddingLeft: 6 + depth * 14 }}
      data-branch-id={branch.id}
      data-depth={depth}
    >
      <button className="tree-main" onClick={activate} title="Open this branch">
        {depth > 0 && <span className="tree-fork-glyph" title={forkFrom ? `forked from turn ${shortId(forkFrom)}` : "forked"}>⑂</span>}
        <span className={`dot dot-${status}`} />
        <span className="tree-label">{branch.displayName ?? "(unnamed)"}</span>
        {busy && <span className="badge busy">running</span>}
        {status === "attention" && <span className="badge attn">attention</span>}
        {status === "error" && <span className="badge err">error</span>}
        {/* Identity is the id, never the name (duplicate names allowed). */}
        <span className="tree-id">{shortId(branch.id)}</span>
        {forkFrom && <span className="tree-forkfrom" title="fork point">↵{shortId(forkFrom)}</span>}
        <span
          className="mode-tag"
          title={branch.workspaceMode === "worktree" ? "Isolated clean HEAD worktree" : "Shared files"}
        >
          {branch.workspaceMode === "worktree" ? "W" : "S"}
        </span>
      </button>
      <div className="tree-actions">
        <button onClick={() => setShowFork((v) => !v)} disabled={muted} title="Fork from any completed turn">
          Fork
        </button>
        <button onClick={archive} disabled={muted} title="Archive branch">
          Archive
        </button>
      </div>
      {showFork && (
        <ForkDialog
          branch={branch}
          defaultNodeId={last?.status === "completed" ? last.id : null}
          onClose={() => setShowFork(false)}
        />
      )}
    </div>
  );
}
