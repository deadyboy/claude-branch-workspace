import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { useStore } from "../store/useStore";
import type { Branch, ConversationNode, WorkspaceMode } from "../types";

interface ForkCandidate {
  node: ConversationNode;
  turn: number;
  preview: string;
}

interface ForkDialogProps {
  branch: Branch;
  /** Prefer this node when opening from a branch row's latest-turn action. */
  defaultNodeId?: string | null;
  onClose: () => void;
}

/**
 * Fork a branch from a persisted, completed conversation turn. Candidates are
 * read from the effective conversation, so inherited turns on a child branch
 * are available as fork points too.
 */
export function ForkDialog({ branch, defaultNodeId = null, onClose }: ForkDialogProps) {
  const [candidates, setCandidates] = useState<ForkCandidate[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState(defaultNodeId ?? "");
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("shared");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError(null);
    void loadCandidates(branch.id).then((loaded) => {
      if (disposed) return;
      setCandidates(loaded);
      const preferred = defaultNodeId && loaded.some((candidate) => candidate.node.id === defaultNodeId)
        ? defaultNodeId
        : loaded[loaded.length - 1]?.node.id ?? "";
      setSelectedNodeId(preferred);
      setLoading(false);
    }).catch((reason: unknown) => {
      if (disposed) return;
      setCandidates([]);
      setLoading(false);
      setError(errorText(reason));
    });
    return () => {
      disposed = true;
    };
  }, [branch.id, defaultNodeId]);

  const selected = useMemo(
    () => candidates.find((candidate) => candidate.node.id === selectedNodeId) ?? null,
    [candidates, selectedNodeId]
  );

  const doFork = async () => {
    if (!selectedNodeId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.createFork(branch.projectId, selectedNodeId, name || undefined, workspaceMode);
      const refreshed = await api.listBranches(branch.projectId);
      useStore.getState().setBranches(refreshed);
      onClose();
    } catch (reason: unknown) {
      // Keep the chooser open so a dirty worktree or a stale node can be
      // corrected without losing the user's selected turn/name.
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fork-dialog" role="dialog" aria-label="Fork branch">
      <div className="fork-title">Fork from a completed turn</div>
      {loading ? (
        <div className="hint">Loading conversation history…</div>
      ) : candidates.length === 0 ? (
        <div className="hint">No completed turns are available on this branch.</div>
      ) : (
        <label className="fork-field">
          <span>Conversation turn</span>
          <select
            aria-label="Fork source turn"
            value={selectedNodeId}
            onChange={(event) => setSelectedNodeId(event.target.value)}
            disabled={busy}
          >
            {candidates.map((candidate) => (
              <option key={candidate.node.id} value={candidate.node.id}>
                {`Turn ${candidate.turn} · ${candidate.preview}`}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="fork-field">
        <span>Workspace mode</span>
        <select
          aria-label="Workspace mode"
          value={workspaceMode}
          onChange={(event) => setWorkspaceMode(event.target.value as WorkspaceMode)}
          disabled={busy}
        >
          <option value="shared">Shared files</option>
          <option value="worktree">Isolated clean HEAD worktree</option>
        </select>
      </label>
      <div className="fork-explanation" role="note">
        {workspaceMode === "shared"
          ? "Shared files: writes are visible to every branch using this workspace."
          : "Worktree: starts from a clean HEAD snapshot. Forking is refused when the source has uncommitted changes."}
      </div>
      <label className="fork-field">
        <span>Branch name</span>
        <input
          type="text"
          value={name}
          placeholder="Branch name (optional)"
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && !busy && void doFork()}
          disabled={busy}
        />
      </label>
      {selected && <div className="hint">Selected turn {selected.turn} is completed and forkable.</div>}
      {error && <div className="fork-error" role="alert">{error}</div>}
      <div className="fork-actions">
        <button onClick={() => void doFork()} disabled={busy || loading || !selectedNodeId}>
          {busy ? "Forking…" : "Fork"}
        </button>
        <button onClick={onClose} disabled={busy}>Cancel</button>
      </div>
    </div>
  );
}

async function loadCandidates(branchId: string): Promise<ForkCandidate[]> {
  const items = await api.conversation(branchId);
  const ids: string[] = [];
  for (const item of items) {
    if (!ids.includes(item.nodeId)) ids.push(item.nodeId);
  }
  const fetched = await Promise.all(ids.map(async (nodeId) => {
    try {
      return await api.node(nodeId);
    } catch {
      return null;
    }
  }));
  const byId = new Map(fetched.filter((node): node is ConversationNode => node !== null).map((node) => [node.id, node]));
  return ids.flatMap((nodeId, index) => {
    const node = byId.get(nodeId);
    if (!node || node.status !== "completed") return [];
    const item = items.find((candidate) => candidate.nodeId === nodeId && candidate.role === "user");
    return [{
      node,
      turn: index + 1,
      preview: compactPreview(item?.content ?? "completed turn"),
    }];
  });
}

function compactPreview(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 72 ? `${oneLine.slice(0, 69)}…` : oneLine;
}

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
