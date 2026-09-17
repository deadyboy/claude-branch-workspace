import { openDb, Repository, DomainService } from "../dist/index.js";

export function newService(dbPath = null) {
  const db = openDb(dbPath);
  const repo = new Repository(db);
  const svc = new DomainService(repo);
  return { db, repo, svc, close: () => db.close() };
}

// Structural digest of a branch's node list: [userText, assistantText?] per turn,
// joined in order. Independent of ids/timestamps → stable across restarts.
export function branchDigest(repo, branchId) {
  const nodes = repo.listNodesByBranch(branchId);
  return nodes.map((n) => {
    const user = repo.getMessage(n.userMessageRef)?.visibleContent ?? null;
    const asst = n.assistantMessageRef ? repo.getMessage(n.assistantMessageRef)?.visibleContent ?? null : null;
    return asst == null ? `U:${user}` : `U:${user}\nA:${asst}`;
  });
}

// Whole-project digest keyed by branch id, with parent linkage included.
// Covers projects/branches/nodes/messages AND snapshots so a lost/corrupt
// snapshot is caught on reopen too.
export function projectDigest(repo, projectId) {
  const branches = repo.listBranchesByProject(projectId).sort((a, b) => a.id.localeCompare(b.id));
  const out = {};
  for (const b of branches) {
    const snap = repo.getSnapshot(b.id);
    out[b.id] = {
      parent: b.parentBranchId,
      forkFrom: b.forkFromNodeId,
      displayName: b.displayName,
      digest: branchDigest(repo, b.id),
      snapshot: snap
        ? {
            forkFromNodeId: snap.forkFromNodeId,
            ancestorNodeIds: snap.ancestorNodeIds,
            visibleMessages: snap.visibleMessages,
          }
        : null,
    };
  }
  return out;
}
