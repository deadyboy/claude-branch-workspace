// S3 / experiment E4a: read-only review of what a branch's work actually
// changed, with a traceable origin.
//
// The two failure modes this panel exists to prevent:
//   1. Showing only `git diff` and therefore MISSING commits made during the
//      run — so committed / uncommitted / untracked are rendered as separate,
//      explicitly-labelled groups.
//   2. Claiming an exclusive artifact when the workspace is SHARED and other
//      branches may have written the same directory — so shared workspaces
//      carry a visible caveat instead of a false attribution.

import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useStore } from "../store/useStore";
import type { BranchChanges, ChangeEntry } from "../types";

const STATUS_LABEL: Record<string, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  untracked: "??",
};

function StatusTag({ status }: { status: string }) {
  return <span className={`chg-status chg-${status}`}>{STATUS_LABEL[status] ?? status}</span>;
}

function ChangeRow({ entry }: { entry: ChangeEntry }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="chg-row">
      <button className="chg-main" onClick={() => setOpen((v) => !v)} title={entry.path}>
        <StatusTag status={entry.status} />
        <span className="chg-path">
          {entry.status === "renamed" && entry.oldPath ? `${entry.oldPath} → ${entry.path}` : entry.path}
        </span>
        {entry.binary && <span className="badge subtle">binary</span>}
        {entry.sizeBytes != null && <span className="chg-size">{entry.sizeBytes}B</span>}
      </button>
      {open && (
        <div className="chg-detail">
          {entry.binary ? (
            // Binary content is never diffed; name/size/type only (S0 §4.2).
            <div className="chg-binary-note">
              Binary file — contents not shown. {entry.sizeBytes != null ? `${entry.sizeBytes} bytes.` : ""}
            </div>
          ) : entry.patch ? (
            <pre className="chg-patch">{entry.patch}</pre>
          ) : (
            <div className="chg-binary-note">No textual diff available.</div>
          )}
        </div>
      )}
    </div>
  );
}

function Group({ title, entries, note }: { title: string; entries: ChangeEntry[]; note?: string }) {
  if (entries.length === 0) return null;
  return (
    <div className="chg-group">
      <div className="chg-group-hd">
        {title} <span className="badge subtle">{entries.length}</span>
        {note && <span className="chg-group-note">{note}</span>}
      </div>
      {entries.map((e) => (
        <ChangeRow key={`${e.status}:${e.oldPath ?? ""}:${e.path}`} entry={e} />
      ))}
    </div>
  );
}

export function ChangesPanel({ branchId }: { branchId: string }) {
  const st = useStore();
  const branch = st.branches.find((b) => b.id === branchId);
  const [changes, setChanges] = useState<BranchChanges | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .branchChanges(branchId)
      .then((c) => {
        if (!cancelled) setChanges(c);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e instanceof Error ? e.message : e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [branchId]);

  if (!branch) return null;

  const total =
    (changes?.committed.length ?? 0) + (changes?.uncommitted.length ?? 0) + (changes?.untracked.length ?? 0);

  return (
    <div className="changes-panel" data-testid="changes-panel">
      <div className="changes-hd">
        <span>Changes</span>
        {changes?.baseRef && (
          <span className="changes-base" title="Baseline recorded before this branch's work began">
            base {changes.baseRef.slice(0, 7)}
          </span>
        )}
        {loading && <span className="badge subtle">loading…</span>}
      </div>

      {error && <div className="hub-error" role="alert">{error}</div>}

      {changes && changes.workspaceMode === "shared" && (
        // Attribution honesty: a shared directory may contain writes from other
        // branches, so this is described as workspace change, not "this agent's
        // artifact" (S0 §4.2 / E4a pass condition).
        <div className="changes-caveat">
          Shared workspace — these changes may include writes from other branches using this directory.
        </div>
      )}

      {changes?.workspaceMode === "worktree" && changes.workspacePath && (
        <div className="changes-workspace" title={changes.workspacePath}>
          isolated worktree
        </div>
      )}

      {changes && total === 0 && !loading && (
        <div className="empty small">No changes yet on this branch.</div>
      )}

      {changes && (
        <>
          <Group
            title="Committed"
            entries={changes.committed}
            // This group is why `git diff` alone is insufficient (E4a).
            note={changes.baseRef ? `since ${changes.baseRef.slice(0, 7)}` : undefined}
          />
          <Group title="Uncommitted" entries={changes.uncommitted} />
          <Group title="Untracked" entries={changes.untracked} />
          {changes.truncated && (
            <div className="changes-caveat">Output truncated — showing the first entries only.</div>
          )}
        </>
      )}
    </div>
  );
}
