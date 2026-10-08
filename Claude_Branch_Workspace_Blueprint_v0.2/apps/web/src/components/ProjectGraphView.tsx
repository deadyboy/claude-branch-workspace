import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api } from "../api/client";
import { useStore } from "../store/useStore";
import type { Branch, FileContentResult, ProjectGraph, ProjectGraphNode } from "../types";
import { ChangesPanel } from "./ChangesPanel";

const MAX_DEPTH = 8;

export function ProjectGraphView({
  onOpenConversation,
}: { onOpenConversation?: (branchId: string, nodeId?: string) => void }) {
  const st = useStore();
  const projectId = st.activeProjectId;
  const [depth, setDepth] = useState(1);
  const [graph, setGraph] = useState<ProjectGraph | null>(null);
  const [loadedProjectId, setLoadedProjectId] = useState<string | null>(null);
  const lastProjectIdRef = useRef<string | null>(projectId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<FileContentResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [fileLoading, setFileLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    if (!projectId) {
      setGraph(null);
      setLoadedProjectId(null);
      setSelectedId(null);
      return;
    }
    if (lastProjectIdRef.current !== projectId) {
      lastProjectIdRef.current = projectId;
      setDepth(1);
      setGraph(null);
      setLoadedProjectId(null);
      setSelectedId(null);
      setFileContent(null);
    }
    setLoading(true);
    setError(null);
    void api.projectGraph(projectId, depth).then((data) => {
      if (disposed || useStore.getState().activeProjectId !== projectId) return;
      setGraph(data);
      setLoadedProjectId(projectId);
      setSelectedId((current) => current && data.nodes.some((node) => node.id === current) ? current : null);
    }).catch((reason: unknown) => {
      if (!disposed && useStore.getState().activeProjectId === projectId) setError(errorText(reason));
    }).finally(() => {
      if (!disposed && useStore.getState().activeProjectId === projectId) setLoading(false);
    });
    return () => { disposed = true; };
  }, [projectId, depth]);

  const visibleGraph = loadedProjectId === projectId ? graph : null;
  const selected = visibleGraph?.nodes.find((node) => node.id === selectedId) ?? null;
  const fileNode = selected?.kind === "file" ? selected : null;

  useEffect(() => {
    let disposed = false;
    setFileContent(null);
    setFileError(null);
    if (!projectId || !fileNode) {
      setFileLoading(false);
      return;
    }
    if (fileNode.exists === false) {
      setFileLoading(false);
      return;
    }
    if (!fileNode.path) {
      setFileError("This file has no safe relative path to open.");
      setFileLoading(false);
      return;
    }
    setFileLoading(true);
    const request = fileNode.branchId
      ? api.branchFileContent(fileNode.branchId, fileNode.path)
      : api.projectFileContent(projectId, fileNode.path);
    void request.then((content) => {
      if (disposed || useStore.getState().activeProjectId !== projectId) return;
      setFileContent(content);
    }).catch((reason: unknown) => {
      if (!disposed && useStore.getState().activeProjectId === projectId) setFileError(errorText(reason));
    }).finally(() => {
      if (!disposed && useStore.getState().activeProjectId === projectId) setFileLoading(false);
    });
    return () => { disposed = true; };
  }, [projectId, selectedId, fileNode?.path, fileNode?.branchId, fileNode?.exists]);

  const nodes = visibleGraph?.nodes ?? [];
  const edges = visibleGraph?.edges ?? [];
  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const childrenByParent = useMemo(() => {
    const map = new Map<string, ProjectGraphNode[]>();
    for (const edge of edges) {
      if (edge.kind !== "contains") continue;
      const child = nodeById.get(edge.target);
      if (!child) continue;
      const list = map.get(edge.source) ?? [];
      list.push(child);
      map.set(edge.source, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.label.localeCompare(b.label));
    return map;
  }, [edges, nodeById]);

  const artifactFiles = (artifactId: string): ProjectGraphNode[] => edges
    .filter((edge) => edge.kind === "produced" && edge.provenance === "artifact.path" && edge.source === artifactId)
    .map((edge) => nodeById.get(edge.target))
    .filter((node): node is ProjectGraphNode => Boolean(node && node.kind === "file"));

  const sourceNodes = (node: ProjectGraphNode): { source: ProjectGraphNode; branch: ProjectGraphNode | null; provenance: ProjectGraph["edges"][number]["provenance"] }[] => {
    const artifactIds = node.kind === "artifact"
      ? [node.id]
      : edges.filter((edge) => edge.kind === "produced" && edge.provenance === "artifact.path" && edge.target === node.id).map((edge) => edge.source);
    const sources: { source: ProjectGraphNode; branch: ProjectGraphNode | null; provenance: ProjectGraph["edges"][number]["provenance"] }[] = [];
    for (const artifactId of artifactIds) {
      for (const edge of edges.filter((item) => item.kind === "produced" && item.target === artifactId)) {
        const source = nodeById.get(edge.source);
        if (!source) continue;
        let branch: ProjectGraphNode | null = source.kind === "branch" ? source : null;
        if (source.kind === "turn" && source.branchId) branch = nodeById.get(`branch:${source.branchId}`) ?? null;
        if (source.kind === "task") {
          const executedBy = edges.find((item) => item.kind === "executedBy" && item.source === source.id);
          branch = executedBy ? nodeById.get(executedBy.target) ?? null : null;
        }
        if (!sources.some((item) => item.source.id === source.id)) sources.push({ source, branch, provenance: edge.provenance });
      }
    }
    return sources;
  };

  const openSource = (source: ProjectGraphNode, branch: ProjectGraphNode | null): void => {
    if (source.kind === "turn" && source.branchId) onOpenConversation?.(source.branchId, source.nodeId);
    else if (branch?.branchId) onOpenConversation?.(branch.branchId);
  };

  const projectRoot = nodes.find((node) => node.kind === "project");
  const tasks = nodes.filter((node) => node.kind === "task");
  const artifacts = nodes.filter((node) => node.kind === "artifact");
  const sourceLinks = selected ? sourceNodes(selected) : [];
  const sourceBranch = sourceLinks.find((item) => item.branch?.branchId)?.branch ?? null;

  if (!projectId) return <div className="pane project-graph"><div className="empty">Open a project to browse its graph.</div></div>;

  return (
    <div className="pane project-graph" data-testid="project-graph-view">
      <div className="project-graph-main">
        <div className="project-graph-hd">
          <strong>Project graph</strong>
          <span className="badge subtle">depth {depth}</span>
          {loading && <span className="badge subtle">loading…</span>}
          {visibleGraph?.truncated && <span className="badge warn">more results available</span>}
          <button data-testid="project-graph-expand" disabled={loading || depth >= MAX_DEPTH} onClick={() => setDepth((value) => Math.min(MAX_DEPTH, value + 1))}>
            Expand one level
          </button>
        </div>
        {error && <div className="hub-error" role="alert">{error}</div>}
        {projectRoot && (
          <section className="project-graph-section">
            <h3>Folders and files</h3>
            <div className="project-tree" data-testid="project-directory-tree">
              {renderTree(projectRoot, 0, childrenByParent, selectedId, setSelectedId)}
              {(childrenByParent.get(projectRoot.id) ?? []).length === 0 && <span className="empty small">No directory entries at this depth.</span>}
            </div>
          </section>
        )}
        <section className="project-graph-section">
          <h3>Tasks</h3>
          {tasks.length === 0 ? <div className="empty small">No task nodes in this project yet.</div> : tasks.map((task) => {
            const executedBy = edges.find((edge) => edge.kind === "executedBy" && edge.source === task.id);
            const branch = executedBy ? nodeById.get(executedBy.target) : undefined;
            return (
              <div className={`project-graph-card ${selectedId === task.id ? "selected" : ""}`} key={task.id} data-testid="project-graph-node" data-node-id={task.id} onClick={() => setSelectedId(task.id)}>
                <button className="project-graph-card-title" onClick={() => setSelectedId(task.id)}><strong>{task.label}</strong><span className="badge subtle">{task.status ?? "task"}</span></button>
                {branch && <button className="link" onClick={() => branch.branchId && onOpenConversation?.(branch.branchId)}>Open task conversation · {branch.label}</button>}
              </div>
            );
          })}
        </section>
        <section className="project-graph-section">
          <h3>成果</h3>
          {artifacts.length === 0 ? <div className="empty small">No linked artifacts yet.</div> : artifacts.map((artifact) => {
            const files = artifactFiles(artifact.id);
            const sources = sourceNodes(artifact);
            return (
              <div className={`project-graph-card ${selectedId === artifact.id ? "selected" : ""}`} key={artifact.id} data-testid="project-graph-node" data-node-id={artifact.id} onClick={() => setSelectedId(artifact.id)}>
                <button className="project-graph-card-title" onClick={() => setSelectedId(artifact.id)}><strong>{artifact.label}</strong><span className="badge subtle">{artifact.status ?? "artifact"}</span></button>
                {files.map((file) => <button className="link" key={file.id} onClick={(event) => { event.stopPropagation(); setSelectedId(file.id); }}>{file.exists === false ? `Missing: ${file.path}` : `Preview ${file.path}`}</button>)}
                {sources.map(({ source, branch, provenance }) => (
                  <div className="project-source-link" key={source.id}>
                    <span>Recorded origin: {provenance}</span>
                    {branch?.branchId && st.branches.find((item) => item.id === branch.branchId)?.workspaceMode === "shared" && <span className="changes-caveat">Shared workspace; this link does not identify exclusive authorship.</span>}
                    <button className="link" data-testid="project-source-conversation" disabled={!branch} onClick={() => openSource(source, branch)}>
                      {source.kind === "task" ? "Open source task conversation" : "Open source conversation"}
                    </button>
                  </div>
                ))}
                {sources.length === 0 && <span className="project-graph-related">Source not linked.</span>}
              </div>
            );
          })}
        </section>
      </div>
      <aside className="project-graph-inspector">
        <div className="project-graph-section-hd">Selection</div>
        {!selected && <div className="empty small">Select a file, task, or artifact.</div>}
        {selected && <SelectionDetails node={selected} sourceLinks={sourceLinks} openSource={openSource} branches={st.branches} />}
        <div className="project-file-preview" data-testid="project-file-preview">
          <div className="project-graph-section-hd">File preview</div>
          {!fileNode && <div className="empty small">Select a file or choose Preview from an artifact.</div>}
          {fileNode && (fileNode.exists === false || fileContent?.exists === false) && <div className="hub-error" data-testid="project-file-missing">File is missing from its recorded workspace: {fileNode.path}</div>}
          {fileNode && fileNode.exists !== false && fileLoading && <div className="hint">Loading file content…</div>}
          {fileError && <div className="hub-error" role="alert">{fileError}</div>}
          {fileNode && fileContent && (
            <>
              <div className="project-file-meta">{fileContent.path} · {fileContent.sizeBytes} bytes{fileContent.binary ? " · binary" : ""}</div>
              {fileContent.binary ? <div className="changes-caveat">Binary content is not displayed.</div> : <pre data-testid="project-file-content" className="project-file-content">{fileContent.content ?? ""}</pre>}
              {fileContent.truncated && <div className="changes-caveat">Preview truncated.</div>}
            </>
          )}
        </div>
        {sourceBranch?.branchId && <ChangesPanel branchId={sourceBranch.branchId} onOpenConversation={(branchId) => onOpenConversation?.(branchId)} />}
      </aside>
    </div>
  );
}

function SelectionDetails({
  node,
  sourceLinks,
  openSource,
  branches,
}: {
  node: ProjectGraphNode;
  sourceLinks: { source: ProjectGraphNode; branch: ProjectGraphNode | null; provenance: ProjectGraph["edges"][number]["provenance"] }[];
  openSource: (source: ProjectGraphNode, branch: ProjectGraphNode | null) => void;
  branches: Branch[];
}) {
  return (
    <div className="project-selection" data-testid="project-graph-selection" data-node-id={node.id}>
      <span className="badge subtle">{node.kind}</span>
      <strong>{node.label}</strong>
      {node.path && <code>{node.path}</code>}
      {node.exists === false && <span className="badge err">missing</span>}
      {node.truncated && <span className="badge warn">directory truncated</span>}
      {sourceLinks.map(({ source, branch, provenance }) => (
        <div className="project-source-link" key={source.id}>
          <span>Recorded origin: {provenance}</span>
          {branch?.branchId && branches.find((item) => item.id === branch.branchId)?.workspaceMode === "shared" && <span className="changes-caveat">Shared workspace; this link does not identify exclusive authorship.</span>}
          <button className="link" disabled={!branch} onClick={() => openSource(source, branch)}>
            {source.kind === "turn" ? "Open source turn" : source.kind === "task" ? "Open source task conversation" : "Open source conversation"}
          </button>
        </div>
      ))}
      {sourceLinks.length === 0 && (node.kind === "file" || node.kind === "artifact") && <span className="project-graph-related">No source relationship recorded.</span>}
    </div>
  );
}

function renderTree(
  node: ProjectGraphNode,
  depth: number,
  childrenByParent: Map<string, ProjectGraphNode[]>,
  selectedId: string | null,
  onSelect: (id: string) => void,
): ReactNode {
  if (node.kind === "directory" || node.kind === "project") {
    const children = childrenByParent.get(node.id) ?? [];
    return (
      <div className="project-dir-row" key={node.id} data-testid="project-graph-node" data-node-id={node.id} style={{ marginLeft: depth * 14 }}>
        <div className="project-dir-label"><span>▸</span><strong>{node.label}</strong>{node.truncated && <span className="badge warn">more below</span>}</div>
        {children.map((child) => renderTree(child, depth + 1, childrenByParent, selectedId, onSelect))}
      </div>
    );
  }
  return (
    <button className={`project-file-row ${selectedId === node.id ? "selected" : ""} ${node.exists === false ? "missing" : ""}`} key={node.id} data-testid="project-graph-node" data-node-id={node.id} onClick={() => onSelect(node.id)} style={{ marginLeft: depth * 14 }}>
      <span>{node.exists === false ? "Missing" : "File"}</span><strong>{node.label}</strong>{node.path && <code>{node.path}</code>}
    </button>
  );
}

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
