// S4 / E4b: apply a task's result back to a target directory.
//
// The whole point of this panel is that applying is DELIBERATE and REVERSIBLE
// in intent: you preview, you see exactly what would move and where, and only
// then do you confirm. A target that changed since the preview is refused with
// the specific change named — never silently overwritten.
//
// The confirm token is opaque to the UI on purpose: it is the server's proof
// that the things the preview described are still true. The UI must not try to
// re-derive or "repair" it.

import { useState } from "react";
import { api } from "../api/client";
import type { ApplyPreview, ApplyResult } from "../types";

export function ApplyPanel({ taskId, onClose }: { taskId: string; onClose?: () => void }) {
  const [preview, setPreview] = useState<ApplyPreview | null>(null);
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function doPreview(): Promise<void> {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const p = await api.applyPreview(taskId);
      setPreview(p);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  async function doApply(): Promise<void> {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.applyConfirm(taskId, preview.confirmToken);
      setResult(r);
    } catch (e) {
      // A 409 here means the target changed since the preview. That is the
      // system WORKING, so surface it as a refusal, not a crash.
      setError(String(e instanceof Error ? e.message : e));
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="apply-panel" data-testid="apply-panel">
      <div className="apply-hd">
        <span>Apply results</span>
        {onClose && <button onClick={onClose}>Close</button>}
      </div>

      {error && <div className="hub-error" role="alert">{error}</div>}

      {!preview && !result && (
        <button onClick={() => void doPreview()} disabled={busy} data-testid="apply-preview-btn">
          {busy ? "Building preview…" : "Preview apply"}
        </button>
      )}

      {preview && !result && (
        <div className="apply-preview" data-testid="apply-preview">
          <div className="apply-target">
            target: <code>{preview.targetPath}</code>
          </div>
          {preview.baseRef && <div className="apply-meta">base {preview.baseRef.slice(0, 7)}</div>}
          {preview.targetDirty && (
            <div className="apply-warning">Target has uncommitted changes of its own.</div>
          )}
          {preview.blocked && <div className="apply-warning">{preview.blocked}</div>}

          <div className="apply-files">
            <div className="apply-files-hd">
              {preview.files.filter((f) => f.decision === "apply").length} file(s) would change
            </div>
            {preview.files.map((f) => (
              <div className={`apply-file apply-${f.decision}`} key={`${f.action}:${f.path}`}>
                <span
                  className={`chg-status chg-${
                    f.action === "delete" ? "deleted" : f.status === "added" || f.status === "untracked" ? "added" : "modified"
                  }`}
                >
                  {f.action === "delete" ? "D" : f.status === "added" || f.status === "untracked" ? "A" : "M"}
                </span>
                <span className="chg-path">{f.path}</span>
                {/* A skip or conflict must state WHY, not just be excluded. */}
                {f.decision !== "apply" && (
                  <span className="badge warn" title={f.reason ?? ""}>
                    {f.decision}
                  </span>
                )}
              </div>
            ))}
          </div>

          {preview.conflicts.length > 0 && (
            <div className="apply-conflicts">
              <div className="apply-files-hd">Conflicts ({preview.conflicts.length})</div>
              {preview.conflicts.map((c) => (
                <div className="apply-conflict" key={c.path}>
                  <span className="chg-path">{c.path}</span>
                  <span className="apply-reason">{c.reason}</span>
                </div>
              ))}
            </div>
          )}

          <div className="apply-actions">
            {/* Explicit confirmation: nothing is written until this click. */}
            <button onClick={() => void doApply()} disabled={busy || !preview.canApply} data-testid="apply-confirm-btn">
              {busy ? "Applying…" : `Apply to ${preview.targetPath}`}
            </button>
            <button onClick={() => setPreview(null)} disabled={busy}>
              Cancel
            </button>
          </div>
          <p className="apply-note">
            If the target changes after this preview, the apply is refused rather than
            partially written.
          </p>
        </div>
      )}

      {result && (
        <div className={`apply-result apply-${result.status}`} data-testid="apply-result">
          <div className="apply-status">
            status: <strong>{result.status}</strong>
            {result.replayed && <span className="badge subtle">already applied (replayed)</span>}
          </div>
          {result.applied && result.applied.length > 0 && (
            <div className="apply-list">
              applied: {result.applied.join(", ")}
            </div>
          )}
          {result.pending && result.pending.length > 0 && (
            // A partial apply must never be presented as success — show the gap.
            <div className="apply-list apply-incomplete">
              not applied: {result.pending.join(", ")}
            </div>
          )}
          {result.targetRestored === false && (
            <div className="apply-warning">
              The target was NOT fully restored. Review the paths above before retrying.
            </div>
          )}
          {result.error && <div className="apply-error">{result.error}</div>}
          <button onClick={() => { setResult(null); setPreview(null); }}>Done</button>
        </div>
      )}
    </div>
  );
}
