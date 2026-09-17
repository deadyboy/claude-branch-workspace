// Left pane: the persistent Conversation Tree (constitution two-tree
// separation). Renders branches with status badge (running / attention /
// error) + workspace-mode icon. Phase 4 = Shared-only (hard gate 14): no
// selectable Worktree control exists here — banner states Worktree = Phase 6.

import { useState } from "react";
import { useStore, branchBusy, branchLastNode } from "../store/useStore";
import { api } from "../api/client";
import type { Branch, ConversationNode } from "../types";

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
  // Only active (non-archived) branches are rendered; archived folded.
  const branches = all.filter((b) => b.status === "active");
  const [archivedOpen, setArchivedOpen] = useState(false);
  const archived = all.filter((b) => b.status === "archived");

  return (
    <aside className="pane tree">
      <div className="pane-hd">
        <span>Conversation Tree</span>
        <span className="badge subtle">Shared only · Worktree = Phase 6</span>
      </div>
      <div className="tree-list">
        {branches.map((b) => (
          <BranchRow key={b.id} branch={b} active={b.id === activeBranchId} />
        ))}
        {branches.length === 0 && <div className="empty">No branches yet</div>}
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
    </aside>
  );
}

function BranchRow({ branch, active, muted = false }: { branch: Branch; active: boolean; muted?: boolean }) {
  const st = useStore();
  const [showFork, setShowFork] = useState(false);
  const busy = branchBusy(st, branch.id);
  const last = branchLastNode(st, branch.id);

  const status = branchStatus(branch);
  const ancestryFork = branch.forkFromNodeId;
  const originLabel = branch.originStrategy === "root"
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
        <span className="mode-tag">{branch.workspaceMode === "worktree" ? "W" : "S"}</span>
      </button>
      <div className="tree-actions">
        <button onClick={() => setShowFork((v) => !v)} disabled={!last || muted} title="Fork from latest turn">
          Fork
        </button>
        <button onClick={archive} disabled={muted} title="Archive branch">
          Archive
        </button>
      </div>
      {showFork && last && <ForkDialog branch={branch} fromNode={last} onClose={() => setShowFork(false)} />}
    </div>
  );
}

function ForkDialog({ branch, fromNode, onClose }: { branch: Branch; fromNode: ConversationNode; onClose: () => void }) {
  const st = useStore();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const doFork = async () => {
    setBusy(true);
    try {
      await api.createFork(branch.projectId, fromNode.id, name || undefined);
      const refreshed = await api.listBranches(branch.projectId);
      st.setBranches(refreshed);
      onClose();
    } catch (e) {
      alert(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fork-dialog">
      <div>Fork new branch from turn {fromNode.localTurnIndex + 1}</div>
      <input
        type="text"
        value={name}
        placeholder="Branch name (optional)"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && !busy && doFork()}
      />
      <div className="fork-actions">
        <button onClick={doFork} disabled={busy}>
          {busy ? "Forking…" : "Fork"}
        </button>
        <button onClick={onClose} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}
