// Project entry point (S1 / experiment E1). Lets the user add, open, and switch
// projects, and — critically — see WHICH MACHINE each project will execute on.
//
// S0 freeze §3: one control-plane instance == one execution host, and
// project.rootPath is always a path on THAT host. The browser cannot hand a
// remote host a local directory, so this pane never implies the user's own
// filesystem is being browsed; it labels the host explicitly and asks for an
// execution-side absolute path, validated by the server.
//
// Capability display is honest (S0 §4.1): when worktree mode is unavailable we
// show the real reason rather than a bare disabled control, and shared mode is
// always offered because a dirty or non-Git directory is still perfectly usable.

import { useEffect, useState } from "react";
import { useStore } from "../store/useStore";
import { api } from "../api/client";
import type { Project, ProjectCapabilities } from "../types";

function shortRoot(rootPath: string | null): string {
  if (!rootPath) return "root path not set";
  const parts = rootPath.split(/[\\/]/).filter(Boolean);
  return parts.length <= 3 ? rootPath : `…/${parts.slice(-2).join("/")}`;
}

export function ProjectHub({
  onClose,
  onOpenProject,
}: {
  onClose: () => void;
  /** Owned by App so switching also reloads branches and restarts the stream. */
  onOpenProject: (projectId: string) => void | Promise<void>;
}) {
  const st = useStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftRoot, setDraftRoot] = useState("");

  // Refresh capabilities for every project when the hub opens, so the mode
  // warnings reflect the host's current filesystem rather than a stale read.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      for (const project of st.projects) {
        try {
          const caps = await api.capabilities(project.id);
          if (!cancelled) useStore.getState().setCapabilities(project.id, caps);
        } catch {
          // A project whose capabilities cannot be read simply shows no badge;
          // switching to it still works and will surface the error on open.
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [st.projects]);

  const host = st.host;

  async function addProject(): Promise<void> {
    const name = draftName.trim();
    const rootPath = draftRoot.trim();
    if (!name || !rootPath) {
      setError("Both a project name and an execution-host path are required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await api.createProject(name, rootPath);
      const projects = await api.listProjects();
      useStore.getState().setProjects(projects);
      useStore.getState().setCapabilities(created.id, await api.capabilities(created.id));
      setAdding(false);
      setDraftName("");
      setDraftRoot("");
    } catch (e) {
      // The server validates that the path exists ON THE EXECUTION HOST; a
      // local-only path must surface as a clear error, never a silent fallback.
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  function openProject(project: Project): void {
    void onOpenProject(project.id);
    onClose();
  }

  return (
    <div className="hub-overlay" role="dialog" aria-label="Projects">
      <div className="hub">
        <div className="hub-hd">
          <span>Projects</span>
          <button onClick={onClose} title="Close project hub">
            Close
          </button>
        </div>

        {/* Execution host banner: the single fact that disambiguates "where will
            this run?" — required by E1's pass condition. */}
        <div className="hub-host" title={host ? `platform ${host.platform}` : "host unknown"}>
          {host ? (
            <>
              <span className="badge subtle">execution host</span>
              <strong>{host.hostname}</strong>
              <span className="hub-host-meta">{host.platform}</span>
              <span className="hub-host-meta" title={host.cwd}>
                {shortRoot(host.cwd)}
              </span>
              {host.adapters.length > 0 && (
                <span className="hub-host-meta">runtimes: {host.adapters.join(", ")}</span>
              )}
            </>
          ) : (
            <span className="hub-host-meta">execution host unavailable</span>
          )}
        </div>
        <p className="hub-note">
          Paths are resolved on the execution host above, not in this browser. Enter an
          absolute directory that exists on that machine.
        </p>

        {error && <div className="hub-error" role="alert">{error}</div>}

        <div className="hub-list">
          {st.projects.length === 0 && <div className="empty">No projects yet.</div>}
          {st.projects.map((project) => {
            const caps = st.capabilitiesByProject[project.id];
            const active = project.id === st.activeProjectId;
            return (
              <div className={`hub-row ${active ? "active" : ""}`} key={project.id}>
                <button
                  className="hub-main"
                  onClick={() => openProject(project)}
                  title="Open this project"
                >
                  <span className="hub-name">{project.name}</span>
                  <span className="hub-root" title={project.rootPath ?? undefined}>
                    {shortRoot(project.rootPath)}
                  </span>
                </button>
                <CapabilityBadges caps={caps} />
                {active && <span className="badge subtle">current</span>}
              </div>
            );
          })}
        </div>

        {!adding && (
          <button className="hub-add" onClick={() => setAdding(true)} disabled={busy}>
            Add project
          </button>
        )}

        {adding && (
          <div className="hub-form">
            <label>
              <span>Name</span>
              <input
                aria-label="Project name"
                value={draftName}
                placeholder="My project"
                onChange={(e) => setDraftName(e.target.value)}
              />
            </label>
            <label>
              <span>Execution-host path</span>
              <input
                aria-label="Execution host path"
                value={draftRoot}
                placeholder="/home/me/project or F:\\project"
                onChange={(e) => setDraftRoot(e.target.value)}
              />
            </label>
            <div className="hub-form-actions">
              <button onClick={() => void addProject()} disabled={busy}>
                {busy ? "Adding…" : "Add"}
              </button>
              <button
                onClick={() => {
                  setAdding(false);
                  setError(null);
                }}
                disabled={busy}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Workspace-mode capability badges (S0 §4.1). Shows the real blocking reason
 * rather than a bare disabled state, and never claims a directory is unusable
 * just because it is dirty — shared mode stays available.
 */
function CapabilityBadges({ caps }: { caps: ProjectCapabilities | undefined }) {
  if (!caps) return null;
  if (!caps.exists) {
    return <span className="badge err" title="Path does not exist on the execution host">path missing</span>;
  }
  return (
    <>
      <span className="badge subtle" title="Shared mode writes are visible to every branch using this directory">
        shared
      </span>
      {caps.worktreeAvailable ? (
        <span className="badge ok" title="Isolated clean HEAD worktree available">
          worktree
        </span>
      ) : (
        <span className="badge warn" title={caps.worktreeReason ?? "worktree unavailable"}>
          no worktree
        </span>
      )}
      {caps.dirty && (
        <span className="badge warn" title="Source has uncommitted changes">
          dirty
        </span>
      )}
    </>
  );
}
