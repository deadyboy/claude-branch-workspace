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

import { useEffect, useRef, useState } from "react";
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

function ChangeRow({ entry, branchId }: { entry: ChangeEntry; branchId: string }) {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState<Awaited<ReturnType<typeof api.branchFileContent>> | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const contentRequestRef = useRef(0);

  async function loadCurrentContent(): Promise<void> {
    if (entry.status === "deleted" || contentLoading) return;
    const requestId = ++contentRequestRef.current;
    setContentLoading(true);
    setContentError(null);
    try {
      const result = await api.branchFileContent(branchId, entry.path);
      if (contentRequestRef.current === requestId) setContent(result);
    } catch (reason) {
      if (contentRequestRef.current === requestId) setContentError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (contentRequestRef.current === requestId) setContentLoading(false);
    }
  }

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
          {entry.patch && !entry.binary && <pre className="chg-patch">{entry.patch}</pre>}
          {entry.status === "deleted" && (
            <div className="chg-binary-note">This file is deleted from the current workspace.</div>
          )}
          {entry.binary ? (
            // Binary content is never diffed; name/size/type only (S0 §4.2).
            <div className="chg-binary-note">
              Binary file — contents not shown. {entry.sizeBytes != null ? `${entry.sizeBytes} bytes.` : ""}
            </div>
          ) : !entry.patch && entry.status !== "deleted" ? (
            <div className="chg-binary-note">No textual diff available.</div>
          ) : null}
          {entry.status !== "deleted" && (
            <div className="chg-current-content">
              <button data-testid="change-current-content" onClick={() => void loadCurrentContent()} disabled={contentLoading}>
                {contentLoading ? "Loading current content…" : content ? "Refresh current content" : "Current content"}
              </button>
              {contentError && <div className="hub-error" role="alert">{contentError}</div>}
              {content?.exists === false && <div className="changes-caveat">File is missing from the current workspace.</div>}
              {content?.exists && (
                <>
                  <div className="chg-size">Current file · {content.path} · {content.sizeBytes} bytes</div>
                  {content.binary ? <div className="chg-binary-note">Binary contents are not displayed.</div> : <pre data-testid="change-current-content-body" className="chg-patch">{content.content ?? ""}</pre>}
                  {content.truncated && <div className="changes-caveat">Current content preview truncated.</div>}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Group({ title, entries, note, branchId }: { title: string; entries: ChangeEntry[]; note?: string; branchId: string }) {
  if (entries.length === 0) return null;
  return (
    <div className="chg-group">
      <div className="chg-group-hd">
        {title} <span className="badge subtle">{entries.length}</span>
        {note && <span className="chg-group-note">{note}</span>}
      </div>
      {entries.map((e) => (
        <ChangeRow key={`${branchId}:${e.status}:${e.oldPath ?? ""}:${e.path}`} entry={e} branchId={branchId} />
      ))}
    </div>
  );
}

export function ChangesPanel({ branchId, onOpenConversation }: { branchId: string; onOpenConversation?: (branchId: string) => void }) {
  const st = useStore();
  const branch = st.branches.find((b) => b.id === branchId);
  const [loadedChanges, setLoadedChanges] = useState<{ branchId: string; changes: BranchChanges } | null>(null);
  const changes = loadedChanges?.branchId === branchId ? loadedChanges.changes : null;
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .branchChanges(branchId)
      .then((c) => {
        if (!cancelled) setLoadedChanges({ branchId, changes: c });
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
        {onOpenConversation && <button data-testid="changes-open-conversation" onClick={() => onOpenConversation(branchId)}>Open source conversation</button>}
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
            branchId={branchId}
            // This group is why `git diff` alone is insufficient (E4a).
            note={changes.baseRef ? `since ${changes.baseRef.slice(0, 7)}` : undefined}
          />
          <Group title="Uncommitted" entries={changes.uncommitted} branchId={branchId} />
          <Group title="Untracked" entries={changes.untracked} branchId={branchId} />
          {changes.truncated && (
            <div className="changes-caveat">Output truncated — showing the first entries only.</div>
          )}
        </>
      )}
    </div>
  );
}
