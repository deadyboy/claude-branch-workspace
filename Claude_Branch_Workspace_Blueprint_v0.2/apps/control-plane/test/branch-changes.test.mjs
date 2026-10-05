// S3 / E4a contract tests (docs/14 §4.2): GET /api/branches/:id/changes.
//
// These pin the two honest behaviours the freeze calls out:
//   * committed AND uncommitted AND untracked are reported separately — a
//     `git diff` alone would drop commits made during a run;
//   * the baseline baseRef is recorded ONCE, before work, and never reset.
// Plus rename detection, binary ⇒ patch:null, and the non-Git / shared caveats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupService, fakeAdapter } from './helpers.mjs';
import { SessionManager } from '../dist/session-manager.js';
import { ForkOrchestrator } from '../dist/fork-orchestrator.js';
import { AttentionRegistry } from '../dist/attention-registry.js';
import { WorkspaceManager } from '../dist/workspace-manager.js';
import { buildApp } from '../dist/server.js';

function gitIn(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { windowsHide: true, encoding: 'utf8' }).trim();
}

function gitInit(root) {
  execFileSync('git', ['-C', root, 'init'], { windowsHide: true });
  gitIn(root, 'config', 'user.name', 'CBW Test');
  gitIn(root, 'config', 'user.email', 'cbw@example.invalid');
  writeFileSync(join(root, 'a.txt'), 'original\n');
  writeFileSync(join(root, 'b.txt'), 'second\n');
  gitIn(root, 'add', '.');
  gitIn(root, 'commit', '-m', 'fixture');
}

async function app(t, s) {
  const adapter = fakeAdapter();
  const sessionManager = new SessionManager(s.svc, adapter);
  const application = await buildApp({
    ctx: {
      ...s, adapter, sessionManager,
      forkOrchestrator: new ForkOrchestrator(s.svc, sessionManager, adapter),
      attention: new AttentionRegistry(),
      workspaceManager: new WorkspaceManager(s.svc),
    },
  });
  await application.ready();
  t.after(async () => { await application.close(); });
  return application;
}

/**
 * A Git project + a worktree branch, bound (baseRef recorded). The worktree is
 * what tests mutate; the source stays clean so binds are never refused.
 */
async function worktreeFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'cbw-chg-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  gitInit(root);
  const s = setupService();
  t.after(s.close);
  const wm = new WorkspaceManager(s.svc);
  const p = s.svc.createProject({ name: 'changes', rootPath: root });
  const main = s.svc.createRootConversation({ projectId: p.id, rootBranchName: 'Main' });
  const node = s.svc.appendCompletedTurn({ branchId: main.id, userContent: 'work', assistantContent: 'ok' });
  const child = s.svc.createBranchFromNode({
    projectId: p.id, forkFromNodeId: node.id, displayName: 'Work', workspaceMode: 'worktree',
  });
  const cwd = await wm.bind(child);
  const application = await app(t, s);
  return { root, cwd, ...s, p, main, node, child, wm, application };
}

const getChanges = async (application, id) => {
  const res = await application.inject(`/api/branches/${id}/changes`);
  return { statusCode: res.statusCode, body: res.statusCode === 200 ? res.json() : null };
};

test('baseRef is recorded on first bind and never overwritten on re-bind', async t => {
  const { root, svc, child, wm } = await worktreeFixture(t);
  const first = svc.getBranch(child.id).baseRef;
  assert.equal(first, gitIn(root, 'rev-parse', 'HEAD'));

  // A second bind (restart / re-bind) must NOT move the baseline.
  await wm.bind(svc.getBranch(child.id));
  assert.equal(svc.getBranch(child.id).baseRef, first);
});

test('uncommitted-only: working-tree edits appear, committed is empty', async t => {
  const { cwd, child, application } = await worktreeFixture(t);
  writeFileSync(join(cwd, 'a.txt'), 'changed in worktree\n');
  const { statusCode, body } = await getChanges(application, child.id);
  assert.equal(statusCode, 200);
  assert.deepEqual(body.committed, []);
  assert.equal(body.uncommitted.length, 1);
  const e = body.uncommitted[0];
  assert.equal(e.path, 'a.txt');
  assert.equal(e.status, 'modified');
  assert.equal(e.binary, false);
  assert.match(e.patch, /\+changed in worktree/);
  assert.deepEqual(body.untracked, []);
  assert.equal(body.truncated, false);
});

test('committed-only: a commit made during the run is reported (not dropped)', async t => {
  const { cwd, child, application } = await worktreeFixture(t);
  writeFileSync(join(cwd, 'a.txt'), 'committed change\n');
  writeFileSync(join(cwd, 'new.txt'), 'brand new\n');
  gitIn(cwd, 'add', '.');
  gitIn(cwd, 'commit', '-m', 'work commit');

  const { body } = await getChanges(application, child.id);
  // This is the whole point of baseRef..HEAD: a bare `git diff` would be empty.
  assert.deepEqual(body.uncommitted, []);
  const byPath = Object.fromEntries(body.committed.map((e) => [e.path, e]));
  assert.equal(body.committed.length, 2);
  assert.equal(byPath['a.txt'].status, 'modified');
  assert.equal(byPath['new.txt'].status, 'added');
  assert.match(byPath['a.txt'].patch, /\+committed change/);
});

test('deleted + renamed (with rename detection) are reported with oldPath', async t => {
  const { cwd, child, application } = await worktreeFixture(t);
  // Delete a file that EXISTS at base (a file added then deleted within the
  // range nets to nothing in base..HEAD, so would correctly not appear).
  gitIn(cwd, 'rm', 'b.txt');
  renameSync(join(cwd, 'a.txt'), join(cwd, 'renamed.txt'));
  gitIn(cwd, 'add', '-A');
  gitIn(cwd, 'commit', '-m', 'delete and rename');

  const { body } = await getChanges(application, child.id);
  const renamed = body.committed.find((e) => e.path === 'renamed.txt');
  const deleted = body.committed.find((e) => e.path === 'b.txt');
  assert.ok(renamed, 'rename detected');
  assert.equal(renamed.status, 'renamed');
  assert.equal(renamed.oldPath, 'a.txt');
  assert.ok(deleted, 'deletion reported');
  assert.equal(deleted.status, 'deleted');
});

test('binary changes carry patch:null with a size hint (tracked and untracked)', async t => {
  const { cwd, child, application } = await worktreeFixture(t);
  // tracked binary (committed)
  writeFileSync(join(cwd, 'image.bin'), Buffer.from([0, 1, 2, 3, 0, 255, 254]));
  gitIn(cwd, 'add', '.');
  gitIn(cwd, 'commit', '-m', 'add binary');
  // untracked binary
  writeFileSync(join(cwd, 'untracked.bin'), Buffer.from([0, 9, 0, 9]));

  const { body } = await getChanges(application, child.id);
  const tracked = body.committed.find((e) => e.path === 'image.bin');
  assert.equal(tracked.binary, true);
  assert.equal(tracked.patch, null);
  assert.equal(tracked.sizeBytes, 7);

  const untracked = body.untracked.find((e) => e.path === 'untracked.bin');
  assert.equal(untracked.binary, true);
  assert.equal(untracked.patch, null);
  assert.equal(untracked.sizeBytes, 4);
});

test('untracked text files appear under untracked with a readable patch', async t => {
  const { cwd, child, application } = await worktreeFixture(t);
  writeFileSync(join(cwd, 'notes.md'), '# scratch\nline two\n');
  const { body } = await getChanges(application, child.id);
  assert.deepEqual(body.committed, []);
  assert.deepEqual(body.uncommitted, []);
  const e = body.untracked.find((x) => x.path === 'notes.md');
  assert.ok(e, 'untracked file reported');
  assert.equal(e.binary, false);
  assert.match(e.patch, /\+# scratch/);
});

test('non-Git shared branch: honest empty result, never 500, baseRef null', async t => {
  const root = mkdtempSync(join(tmpdir(), 'cbw-chg-nogit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const s = setupService();
  t.after(s.close);
  const wm = new WorkspaceManager(s.svc);
  const p = s.svc.createProject({ name: 'plain', rootPath: root });
  const main = s.svc.createRootConversation({ projectId: p.id });
  await wm.bind(main);
  const application = await app(t, s);

  const { statusCode, body } = await getChanges(application, main.id);
  assert.equal(statusCode, 200);
  assert.equal(body.baseRef, null);
  assert.equal(body.workspaceMode, 'shared');
  assert.deepEqual(body.committed, []);
  assert.deepEqual(body.uncommitted, []);
  assert.deepEqual(body.untracked, []);
  assert.equal(body.truncated, false);
});

test('unbound branch returns the frozen shape with null path (no bind required)', async t => {
  const root = mkdtempSync(join(tmpdir(), 'cbw-chg-unbound-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  gitInit(root);
  const s = setupService();
  t.after(s.close);
  const p = s.svc.createProject({ name: 'u', rootPath: root });
  const main = s.svc.createRootConversation({ projectId: p.id }); // never bound
  const application = await app(t, s);

  const { statusCode, body } = await getChanges(application, main.id);
  assert.equal(statusCode, 200);
  assert.equal(body.workspacePath, null);
  assert.equal(body.baseRef, null);
  assert.ok(Array.isArray(body.committed) && Array.isArray(body.uncommitted) && Array.isArray(body.untracked));
});

test('attribution: projectId/branchId/sourceBranchId, latestNodeId, 404 unknown', async t => {
  const { svc, p, main, node, child, application } = await worktreeFixture(t);
  // The child has no turns of its own yet → latestNodeId null…
  let { body } = await getChanges(application, child.id);
  assert.equal(body.projectId, p.id);
  assert.equal(body.branchId, child.id);
  assert.equal(body.sourceBranchId, child.parentBranchId);
  assert.equal(body.latestNodeId, null);
  // worktree is exclusive → not flagged as possibly-shared
  assert.equal(body.sharedWorkspace, false);

  // …and once the branch has a completed turn, that turn is the reported one.
  const childTurn = svc.appendCompletedTurn({ branchId: child.id, userContent: 'c', assistantContent: 'ok' });
  ({ body } = await getChanges(application, child.id));
  assert.equal(body.latestNodeId, childTurn.id);
  assert.notEqual(childTurn.id, node.id); // source-branch turn is NOT attributed here

  assert.equal((await application.inject('/api/branches/nope/changes')).statusCode, 404);
});

test('shared mode on a Git folder flags sharedWorkspace and still reports diffs', async t => {
  const root = mkdtempSync(join(tmpdir(), 'cbw-chg-shared-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  gitInit(root);
  const s = setupService();
  t.after(s.close);
  const wm = new WorkspaceManager(s.svc);
  const p = s.svc.createProject({ name: 'shared', rootPath: root });
  const main = s.svc.createRootConversation({ projectId: p.id });
  await wm.bind(main); // shared bind records baseRef from HEAD
  assert.equal(s.svc.getBranch(main.id).baseRef, gitIn(root, 'rev-parse', 'HEAD'));
  writeFileSync(join(root, 'a.txt'), 'touched by someone\n');
  const application = await app(t, s);

  const { body } = await getChanges(application, main.id);
  assert.equal(body.workspaceMode, 'shared');
  // Honesty: shared dirs may contain other branches' writes → caveat flag set.
  assert.equal(body.sharedWorkspace, true);
  assert.equal(body.uncommitted[0].path, 'a.txt');
});
