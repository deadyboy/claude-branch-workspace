// S5 / E8 contract tests (docs/14 §4.4): GET /api/projects/:id/graph?depth=N.
//
// These pin the E8 acceptance conditions:
//   * the THREE promised relationship classes are each correct and carry a
//     distinct provenance (contains / executedBy / produced);
//   * an artifact can be traced back to its source along the edges;
//   * a missing file is `exists:false` (never shown as openable);
//   * excluded content (.git / node_modules / credential files) never appears,
//     and file CONTENTS are NEVER leaked into the response;
//   * depth bounds the directory tree and `truncated` is honest;
//   * a symlink cannot escape rootPath.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupService, fakeAdapter } from './helpers.mjs';
import { SessionManager } from '../dist/session-manager.js';
import { ForkOrchestrator } from '../dist/fork-orchestrator.js';
import { AttentionRegistry } from '../dist/attention-registry.js';
import { buildApp } from '../dist/server.js';

// A marker that must NEVER appear in a graph response (it lives inside files the
// endpoint is forbidden to read).
const SECRET = 'TOPSECRET-MARKER-8f3a1c';

async function makeApp(t, s) {
  const adapter = fakeAdapter();
  const sessionManager = new SessionManager(s.svc, adapter);
  const app = await buildApp({
    ctx: {
      ...s, adapter, sessionManager,
      forkOrchestrator: new ForkOrchestrator(s.svc, sessionManager, adapter),
      attention: new AttentionRegistry(),
    },
  });
  await app.ready();
  t.after(async () => { await app.close(); });
  return app;
}

/** A synthetic non-Git project directory plus the excluded decoys. */
function makeTree(t) {
  const root = mkdtempSync(join(tmpdir(), 'cbw-graph-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  writeFileSync(join(root, 'README.md'), 'hello\n');
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs', 'notes.md'), 'notes\n');
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'src', 'nested'));
  writeFileSync(join(root, 'src', 'nested', 'deep.txt'), 'deep\n');

  // ---- decoys that must be excluded ----
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, '.git', 'config'), 'gitconfig\n');
  mkdirSync(join(root, 'node_modules'));
  writeFileSync(join(root, 'node_modules', 'index.js'), 'module\n');
  writeFileSync(join(root, '.env'), `SECRET=${SECRET}\n`);
  writeFileSync(join(root, 'server.pem'), `-----BEGIN KEY-----\n${SECRET}\n`);
  writeFileSync(join(root, 'id_rsa'), `${SECRET}\n`);

  return root;
}

const getGraph = async (app, id, query = '') => {
  const res = await app.inject(`/api/projects/${id}/graph${query}`);
  return { statusCode: res.statusCode, raw: res.body, body: res.statusCode === 200 ? res.json() : null };
};

/** Fixture: project + branch + turn + task + artifacts over one synthetic tree. */
async function fixture(t) {
  const root = makeTree(t);
  const s = setupService();
  t.after(s.close);
  const app = await makeApp(t, s);

  const p = s.svc.createProject({ name: 'P2 notes', rootPath: root });
  const main = s.svc.createRootConversation({ projectId: p.id, rootBranchName: 'Main' });
  const turn = s.svc.appendCompletedTurn({ branchId: main.id, userContent: 'do it', assistantContent: 'ok' });
  const task = s.svc.createTask({ projectId: p.id, title: 'Write notes', instructions: 'i', branchId: main.id, status: 'running' });

  // report artifact: origin branch + turn + task, path present on disk.
  const report = s.svc.createArtifact({
    projectId: p.id, originBranchId: main.id, originNodeId: turn.id, originTaskId: task.id,
    kind: 'report', path: 'docs/notes.md', summary: 'notes report',
  });
  // file artifact whose path does NOT exist (deleted / never created).
  const gone = s.svc.createArtifact({
    projectId: p.id, originBranchId: main.id, originNodeId: turn.id,
    kind: 'file', path: 'docs/missing.md', summary: 'gone file',
  });

  return { root, app, ...s, p, main, turn, task, report, gone };
}

function incomingMap(graph) {
  const map = new Map(); // target node id -> [edge]
  for (const e of graph.edges) {
    const list = map.get(e.target) ?? [];
    list.push(e);
    map.set(e.target, list);
  }
  return map;
}

/** BFS upstream from a node id, following edges backwards (target -> source). */
function reachableBackwards(graph, from) {
  const incoming = incomingMap(graph);
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift();
    for (const e of incoming.get(cur) ?? []) {
      if (!seen.has(e.source)) { seen.add(e.source); queue.push(e.source); }
    }
  }
  return seen;
}

test('relationship class 1 (contains): project -> directory -> file, provenance filesystem', async t => {
  const { app, p } = await fixture(t);
  const { statusCode, body } = await getGraph(app, p.id);
  assert.equal(statusCode, 200);

  const ids = new Set(body.nodes.map(n => n.id));
  assert.ok(ids.has(`project:${p.id}`), 'project node');
  assert.ok(ids.has('dir:docs'));
  assert.ok(ids.has('file:docs/notes.md'));
  assert.ok(ids.has('dir:src/nested'));
  assert.ok(ids.has('file:src/nested/deep.txt'));

  const containsEdges = body.edges.filter(e => e.kind === 'contains');
  assert.ok(containsEdges.length >= 4);
  assert.ok(containsEdges.every(e => e.provenance === 'filesystem'));
  // project is the root of the containment tree.
  assert.ok(containsEdges.some(e => e.source === `project:${p.id}` && e.target === 'dir:docs'));
  assert.ok(containsEdges.some(e => e.source === 'dir:docs' && e.target === 'file:docs/notes.md'));
  // file nodes carry a real size and exists=true.
  const f = body.nodes.find(n => n.id === 'file:docs/notes.md');
  assert.equal(f.exists, true);
  assert.equal(typeof f.sizeBytes, 'number');
  assert.equal(f.path, 'docs/notes.md');
});

test('relationship class 2 (executedBy): task -> branch, provenance task.branchId', async t => {
  const { app, p, task, main } = await fixture(t);
  const { body } = await getGraph(app, p.id);

  assert.ok(body.nodes.some(n => n.id === `task:${task.id}` && n.kind === 'task'));
  assert.ok(body.nodes.some(n => n.id === `branch:${main.id}` && n.kind === 'branch'));

  const e = body.edges.find(x => x.kind === 'executedBy');
  assert.ok(e, 'an executedBy edge exists');
  assert.equal(e.source, `task:${task.id}`);
  assert.equal(e.target, `branch:${main.id}`);
  assert.equal(e.provenance, 'task.branchId');
});

test('relationship class 3 (produced): artifact -> turn/branch/task/file, provenance per origin field', async t => {
  const { app, p, report, main, task, turn } = await fixture(t);
  const { body } = await getGraph(app, p.id);

  const produced = body.edges.filter(e => e.kind === 'produced' && e.target === `artifact:${report.id}`);
  const byProv = new Map(produced.map(e => [e.provenance, e]));
  assert.ok(byProv.has('artifact.originBranchId'));
  assert.ok(byProv.has('artifact.originNodeId'));
  assert.ok(byProv.has('artifact.originTaskId'));
  assert.equal(byProv.get('artifact.originBranchId').source, `branch:${main.id}`);
  assert.equal(byProv.get('artifact.originNodeId').source, `turn:${turn.id}`);
  assert.equal(byProv.get('artifact.originTaskId').source, `task:${task.id}`);

  // artifact -> its file (distinct provenance: the path was DECLARED, not scanned).
  const toFile = body.edges.find(e => e.kind === 'produced' && e.target === 'file:docs/notes.md');
  assert.ok(toFile, 'artifact -> file edge');
  assert.equal(toFile.provenance, 'artifact.path');
  assert.equal(toFile.source, `artifact:${report.id}`);
});

test('E8: each artifact traces back to its source task/branch/turn within a few hops', async t => {
  const { app, p, report } = await fixture(t);
  const { body } = await getGraph(app, p.id);

  const reach = reachableBackwards(body, `artifact:${report.id}`);
  assert.ok([...reach].some(id => id.startsWith('task:')), 'reaches a task');
  assert.ok([...reach].some(id => id.startsWith('branch:')), 'reaches a branch');
  assert.ok([...reach].some(id => id.startsWith('turn:')), 'reaches a turn');

  // 3-navigation budget: task is a direct edge, branch is direct, turn direct.
  const direct = new Set(body.edges.filter(e => e.target === `artifact:${report.id}`).map(e => e.source));
  assert.ok([...direct].some(id => id.startsWith('task:')));
  assert.ok([...direct].some(id => id.startsWith('branch:')));
  assert.ok([...direct].some(id => id.startsWith('turn:')));
});

test('E8: a non-existent file is exists:false and is not backed by a contains edge', async t => {
  const { app, p, gone } = await fixture(t);
  const { body } = await getGraph(app, p.id);

  const node = body.nodes.find(n => n.id === 'file:docs/missing.md');
  assert.ok(node, 'the declared path still yields a node (current state shown)');
  assert.equal(node.exists, false);
  assert.equal(node.sizeBytes, undefined);
  // The artifact -> file edge is still present (provenance says where it came from),
  // but NO filesystem contains edge claims the file is on disk.
  assert.ok(body.edges.some(e => e.kind === 'produced' && e.target === 'file:docs/missing.md' && e.provenance === 'artifact.path'));
  assert.ok(!body.edges.some(e => e.kind === 'contains' && e.target === 'file:docs/missing.md'));
});

test('E8 exclusion: .git / node_modules / caches / credential files never appear, contents never leak', async t => {
  const { app, p } = await fixture(t);
  const { raw, body } = await getGraph(app, p.id);

  const paths = body.nodes.filter(n => n.path).map(n => n.path);
  assert.ok(!paths.some(x => x.startsWith('.git')), '.git excluded');
  assert.ok(!paths.some(x => x.startsWith('node_modules')), 'node_modules excluded');
  assert.ok(!paths.includes('.env'), '.env excluded');
  assert.ok(!paths.includes('server.pem'), '*.pem excluded');
  assert.ok(!paths.includes('id_rsa'), 'id_rsa excluded');

  // The hard line: the response MUST NOT carry file contents.
  assert.ok(!raw.includes(SECRET), 'credential contents must never be in the response');
  assert.ok(!raw.includes('-----BEGIN'), 'key material must never be in the response');
  assert.ok(!raw.includes('gitconfig'), 'excluded file contents must never be in the response');
});

test('E8 depth: bounds directory expansion and reports truncated honestly', async t => {
  const { app, p } = await fixture(t);

  // depth=1 → only top-level entries; nested files absent; truncated true.
  // NOTE: docs/notes.md still appears here because an ARTIFACT declares it — that
  // is provenance, not directory depth. So the depth check uses a file no
  // artifact references (src/nested/deep.txt).
  const d1 = (await getGraph(app, p.id, '?depth=1')).body;
  const d1paths = d1.nodes.filter(n => n.path).map(n => n.path);
  assert.ok(d1paths.includes('README.md'));
  assert.ok(!d1paths.includes('src/nested/deep.txt'), 'depth 1 does not reach nested src');
  assert.equal(d1.truncated, true);

  // depth=0 → no directory containment at all (only domain/artifact relations).
  const d0 = (await getGraph(app, p.id, '?depth=0')).body;
  assert.equal(d0.edges.filter(e => e.kind === 'contains').length, 0);
  assert.equal(d0.truncated, true);

  // default depth (3) reaches src/nested/deep.txt.
  const dd = (await getGraph(app, p.id)).body;
  assert.ok(dd.nodes.some(n => n.path === 'src/nested/deep.txt'));

  // invalid depth rejected.
  assert.equal((await getGraph(app, p.id, '?depth=-1')).statusCode, 400);
  assert.equal((await getGraph(app, p.id, '?depth=abc')).statusCode, 400);

  // unknown project → 404.
  assert.equal((await getGraph(app, 'nope')).statusCode, 404);
});

test('E8 path safety: an artifact path outside rootPath is not opened (exists:false, never read)', async t => {
  const root = makeTree(t);
  const s = setupService();
  t.after(s.close);
  const app = await makeApp(t, s);
  const p = s.svc.createProject({ name: 'escape', rootPath: root });

  // A traversal path AND an absolute out-of-root path.
  s.svc.createArtifact({ projectId: p.id, kind: 'file', path: '../../outside.txt', summary: 'traversal' });
  const absOutside = join(tmpdir(), 'cbw-graph-outside.txt');
  writeFileSync(absOutside, `OUTSIDE ${SECRET}\n`);
  t.after(() => rmSync(absOutside, { force: true }));
  s.svc.createArtifact({ projectId: p.id, kind: 'file', path: absOutside, summary: 'absolute' });

  const { raw, body } = await getGraph(app, p.id);
  // The two out-of-root declared paths yield nodes, both with exists:false.
  const traversal = body.nodes.find(n => n.id === 'file:../../outside.txt');
  assert.ok(traversal, 'the traversal path yields a node');
  assert.equal(traversal.exists, false);
  const absNode = body.nodes.find(n => n.kind === 'file' && n.path === absOutside.replace(/\\/g, '/'));
  assert.ok(absNode, 'the absolute out-of-root path yields a node');
  assert.equal(absNode.exists, false);
  // Scanned in-root files are still present with exists:true — only the escapes are false.
  assert.ok(body.nodes.some(n => n.kind === 'file' && n.exists === true));
  assert.ok(!raw.includes(SECRET), 'out-of-root file contents are never read');
});

test('E8 path safety: a symlink cannot escape rootPath', async t => {
  const root = makeTree(t);
  // A secret file OUTSIDE the project root.
  const outsideDir = mkdtempSync(join(tmpdir(), 'cbw-outside-'));
  t.after(() => rmSync(outsideDir, { recursive: true, force: true }));
  writeFileSync(join(outsideDir, 'secret.txt'), `ESCAPED ${SECRET}\n`);

  let linked = true;
  try {
    symlinkSync(join(outsideDir, 'secret.txt'), join(root, 'link-to-secret.txt'), 'file');
  } catch {
    linked = false; // Windows may refuse FILE symlinks without privileges.
  }
  // A directory junction needs no special privilege on Windows — use it so the
  // dir-escape guard is exercised even when file symlinks are unavailable.
  let junctionOk = false;
  try {
    symlinkSync(outsideDir, join(root, 'link-outside-dir'), 'junction');
    junctionOk = true;
  } catch { /* fall through */ }
  if (!linked && !junctionOk) { t.skip('no symlink/junction support on this host'); return; }

  const s = setupService();
  t.after(s.close);
  const app = await makeApp(t, s);
  const p = s.svc.createProject({ name: 'links', rootPath: root });

  const { raw, body } = await getGraph(app, p.id);
  const paths = body.nodes.filter(n => n.path).map(n => n.path);
  assert.ok(!paths.includes('link-to-secret.txt'), 'symlink to an outside file is excluded');
  assert.ok(!paths.some(x => x.startsWith('link-outside-dir')), 'symlink/junction to an outside dir is excluded');
  assert.ok(!raw.includes(SECRET), 'nothing behind the symlink is read');
});
