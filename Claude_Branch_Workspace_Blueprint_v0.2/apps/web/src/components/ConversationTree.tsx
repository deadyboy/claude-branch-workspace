// Left pane: the persistent Conversation Tree (constitution two-tree
// separation). Renders branches with status badge (running / attention /
// error) + explicit shared/worktree mode. The list is bounded so a project
// with many branches stays responsive while search and pagination remain local.

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

export function ConversationTree() {
  const states = useStore();
  const activeBranchId = states.activeBranchId;
  const all = states.branches;
  const [search, setSearch] = useState("");
  const [activeOnly, setActiveOnly] = useState(true);
  const [visibleLimit, setVisibleLimit] = useState(BRANCH_PAGE_SIZE);
  const [archivedOpen, setArchivedOpen] = useState(false);

  useEffect(() => {
    setVisibleLimit(BRANCH_PAGE_SIZE);
  }, [search, activeOnly]);

  const matching = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return all.filter((branch) => {
      if (activeOnly && branch.status !== "active") return false;
      if (!needle) return true;
      return [branch.displayName ?? "", branch.id, branch.workspacePath ?? ""]
        .some((value) => value.toLocaleLowerCase().includes(needle));
    });
  }, [activeOnly, all, search]);
  const visible = matching.slice(0, visibleLimit);
  const branches = visible.filter((b) => b.status === "active");
  const archived = visible.filter((b) => b.status === "archived");

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
        <span className="tree-count">{visible.length} / {matching.length}</span>
      </div>
      <div className="tree-list">
        {branches.map((b) => (
          <BranchRow key={b.id} branch={b} active={b.id === activeBranchId} />
        ))}
        {branches.length === 0 && archived.length === 0 && <div className="empty">No matching branches</div>}
      </div>
      {archived.length > 0 && (
        <details open={archivedOpen} onToggle={(e) => setArchivedOpen((e.target as HTMLDetailsElement).open)}>
          <summary className="tree-summary">Archived ({archived.length})</summary>
          <div className="tree-list">
            {archived.map((b) => (
              <BranchRow key={b.id} branch={b} active={false} muted />
            ))}
          </div>
        </details>
      )}
      {visible.length < matching.length && (
        <button className="tree-more" onClick={() => setVisibleLimit((limit) => limit + BRANCH_PAGE_SIZE)}>
          Show more ({matching.length - visible.length} remaining)
        </button>
      )}
    </aside>
  );
}

const BRANCH_PAGE_SIZE = 50;

function BranchRow({ branch, active, muted = false }: { branch: Branch; active: boolean; muted?: boolean }) {
  const st = useStore();
  const [showFork, setShowFork] = useState(false);
  const busy = branchBusy(st, branch.id);
  const last = branchLastNode(st, branch.id);

  const status = branchStatus(branch);
  const ancestryFork = branch.forkFromNodeId;
  const originLabel = branch.originStrategy === "root" || branch.originStrategy === "imported"
    ? branch.displayName ?? "(root)"
    : `${branch.displayName ?? "fork"} · ${ancestryFork ? "node " + shortId(ancestryFork) : ""}`;

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
    <div className={`tree-row ${active ? "active" : ""} ${muted ? "muted" : ""}`}>
      <button className="tree-main" onClick={activate} title="Open this branch">
        <span className={`dot dot-${status}`} />
        <span className="tree-label">{originLabel}</span>
        {busy && <span className="badge busy">running</span>}
        {status === "attention" && <span className="badge attn">attention</span>}
        {status === "error" && <span className="badge err">error</span>}
        <span className="tree-id">{shortId(branch.id)}</span>
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
      {showFork && <ForkDialog branch={branch} defaultNodeId={last?.status === "completed" ? last.id : null} onClose={() => setShowFork(false)} />}
    </div>
  );
}
