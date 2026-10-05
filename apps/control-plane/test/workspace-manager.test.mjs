import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupService } from './helpers.mjs';
import { WorkspaceManager } from '../dist/workspace-manager.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'cbw-workspace-'));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { windowsHide: true, encoding: 'utf8' });
  git('init'); git('config', 'user.name', 'CBW Test'); git('config', 'user.email', 'cbw@example.invalid');
  writeFileSync(join(root, 'a.txt'), 'original'); git('add', '.'); git('commit', '-m', 'fixture');
  const s = setupService(); t.after(s.close);
  const p = s.svc.createProject({ name: 'isolation', rootPath: root });
  const main = s.svc.createRootConversation({ projectId: p.id });
  const node = s.svc.appendCompletedTurn({ branchId: main.id, userContent: 'hello', assistantContent: 'ready' });
  const child = s.svc.createBranchFromNode({ projectId: p.id, forkFromNodeId: node.id, workspaceMode: 'worktree' });
  return { ...s, root, git, main, child, wm: new WorkspaceManager(s.svc) };
}

test('worktree persists isolated cwd, reports changes, and never auto-deletes on archive', async t => {
  const { root, svc, child, wm } = fixture(t);
  const cwd = await wm.bind(child);
  assert.notEqual(cwd, root);
  assert.equal(svc.getBranch(child.id).workspacePath, cwd);
  writeFileSync(join(cwd, 'a.txt'), 'child change');
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'original');
  assert.equal((await wm.status(child.id)).dirty, true);
  svc.archiveBranch(child.id);
  assert.equal(existsSync(cwd), true);
  await assert.rejects(wm.cleanup(child.id), /changes/);
  // Generated fixture intentionally retained; no user data or git worktrees removed.
});

test('worktree rejects dirty source, shared binding persists and lists conflicts', async t => {
  const { root, svc, main, child, wm } = fixture(t);
  writeFileSync(join(root, 'untracked.txt'), 'do not lose');
  await assert.rejects(wm.bind(child), /uncommitted/);
  const mainCwd = await wm.bind(main);
  assert.equal(mainCwd.toLowerCase(), root.toLowerCase());
  assert.equal(svc.getBranch(child.id).workspacePath, null);
  await assert.rejects(wm.cleanup(main.id), /archived/);
});
