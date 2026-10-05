// S1 project entry contract (docs/14 §4.1): GET /api/host, capability probe
// GET /api/projects/:id/capabilities, and PATCH /api/projects/:id. These assert
// the frozen shapes AND the honesty rules — every worktreeReason branch, and
// that a dirty source disables worktree mode WITHOUT disabling shared mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { setupService, fakeAdapter } from './helpers.mjs';
import { SessionManager } from '../dist/session-manager.js';
import { ForkOrchestrator } from '../dist/fork-orchestrator.js';
import { AttentionRegistry } from '../dist/attention-registry.js';
import { buildApp } from '../dist/server.js';

async function setup(t) {
  const s = setupService(); const adapter = fakeAdapter();
  const sessionManager = new SessionManager(s.svc, adapter);
  const app = await buildApp({ ctx: { ...s, adapter, sessionManager,
    forkOrchestrator: new ForkOrchestrator(s.svc, sessionManager, adapter), attention: new AttentionRegistry() } });
  await app.ready();
  const dirs = [];
  const mk = (prefix) => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
  t.after(async () => { await app.close(); s.close(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
  return { ...s, app, mk };
}

function gitInit(root, { commit = true } = {}) {
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { windowsHide: true, encoding: 'utf8' });
  git('init'); git('config', 'user.name', 'CBW Test'); git('config', 'user.email', 'cbw@example.invalid');
  if (commit) { writeFileSync(join(root, 'a.txt'), 'original'); git('add', '.'); git('commit', '-m', 'fixture'); }
}

test('GET /api/host returns the frozen {hostname, platform, cwd, adapters} shape', async t => {
  const { app } = await setup(t);
  const res = await app.inject({ method: 'GET', url: '/api/host' });
  assert.equal(res.statusCode, 200);
  const host = res.json();
  assert.equal(host.hostname, hostname());
  assert.equal(host.platform, process.platform);
  assert.equal(host.cwd, process.cwd());
  assert.ok(Array.isArray(host.adapters) && host.adapters.length >= 1);
  assert.ok(host.adapters.every(a => typeof a === 'string'));
});

test('capabilities: clean committed Git repo is worktree-available', async t => {
  const { app, svc, mk } = await setup(t);
  const root = mk('cbw-cap-clean-'); gitInit(root);
  const p = svc.createProject({ name: 'clean', rootPath: root });
  const res = await app.inject(`/api/projects/${p.id}/capabilities`);
  assert.equal(res.statusCode, 200);
  const c = res.json();
  assert.deepEqual(
    { rootPath: c.rootPath, exists: c.exists, isGit: c.isGit, dirty: c.dirty, hasCommits: c.hasCommits },
    { rootPath: root, exists: true, isGit: true, dirty: false, hasCommits: true },
  );
  assert.equal(c.worktreeAvailable, true);
  assert.equal(c.worktreeReason, null);
  assert.equal(c.sharedAvailable, true);
});

test('capabilities: non-Git directory → worktree unavailable, reason names Git', async t => {
  const { app, svc, mk } = await setup(t);
  const root = mk('cbw-cap-nogit-'); // plain folder, no git init
  const p = svc.createProject({ name: 'plain', rootPath: root });
  const c = (await app.inject(`/api/projects/${p.id}/capabilities`)).json();
  assert.equal(c.exists, true);
  assert.equal(c.isGit, false);
  assert.equal(c.worktreeAvailable, false);
  assert.match(c.worktreeReason, /Git/);
  assert.equal(c.sharedAvailable, true);
});

test('capabilities: Git repo with no first commit → worktree unavailable', async t => {
  const { app, svc, mk } = await setup(t);
  const root = mk('cbw-cap-nocommit-'); gitInit(root, { commit: false });
  const p = svc.createProject({ name: 'nocommit', rootPath: root });
  const c = (await app.inject(`/api/projects/${p.id}/capabilities`)).json();
  assert.equal(c.isGit, true);
  assert.equal(c.hasCommits, false);
  assert.equal(c.worktreeAvailable, false);
  assert.match(c.worktreeReason, /提交/);
  assert.equal(c.sharedAvailable, true);
});

test('capabilities: dirty source disables WORKTREE but never shared mode', async t => {
  const { app, svc, mk } = await setup(t);
  const root = mk('cbw-cap-dirty-'); gitInit(root);
  writeFileSync(join(root, 'untracked.txt'), 'do not lose');
  const p = svc.createProject({ name: 'dirty', rootPath: root });
  const c = (await app.inject(`/api/projects/${p.id}/capabilities`)).json();
  assert.equal(c.isGit, true);
  assert.equal(c.hasCommits, true);
  assert.equal(c.dirty, true);
  // Honest: a bind() right now would be refused, so worktree is unavailable…
  assert.equal(c.worktreeAvailable, false);
  assert.match(c.worktreeReason, /未提交|提交/);
  // …but the project itself is NOT blocked — shared mode stays open.
  assert.equal(c.sharedAvailable, true);
});

test('capabilities: inaccessible path → worktree unavailable with path reason', async t => {
  const { app, svc } = await setup(t);
  const p = svc.createProject({ name: 'gone', rootPath: join(tmpdir(), 'cbw-does-not-exist-' + Date.now()) });
  const c = (await app.inject(`/api/projects/${p.id}/capabilities`)).json();
  assert.equal(c.exists, false);
  assert.equal(c.worktreeAvailable, false);
  assert.match(c.worktreeReason, /路径|目录/);
  assert.equal(c.sharedAvailable, true);
});

test('capabilities and PATCH 404 for an unknown project', async t => {
  const { app } = await setup(t);
  assert.equal((await app.inject('/api/projects/missing/capabilities')).statusCode, 404);
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/projects/missing', payload: { name: 'x' } })).statusCode, 404);
});

test('PATCH renames and repoints rootPath, preserving identity and old branches', async t => {
  const { app, svc, mk } = await setup(t);
  const a = mk('cbw-patch-a-'); const b = mk('cbw-patch-b-');
  const p = svc.createProject({ name: 'original', rootPath: a });
  const main = svc.createRootConversation({ projectId: p.id, rootBranchName: 'Main' });

  const res = await app.inject({ method: 'PATCH', url: `/api/projects/${p.id}`, payload: { name: 'renamed', rootPath: b } });
  assert.equal(res.statusCode, 200);
  const updated = res.json();
  assert.equal(updated.id, p.id);                       // identity preserved
  assert.equal(updated.createdAt, p.createdAt);         // createdAt untouched
  assert.equal(updated.name, 'renamed');
  assert.equal(updated.rootPath, b);
  assert.notEqual(updated.updatedAt, p.updatedAt);      // touched

  // Old data remains readable and still points at the same project id.
  assert.equal(svc.getProject(p.id).name, 'renamed');
  assert.equal(svc.getBranch(main.id).projectId, p.id);
});

test('PATCH validates like POST: name non-empty, rootPath absolute + existing dir', async t => {
  const { app, svc, mk } = await setup(t);
  const root = mk('cbw-patch-valid-');
  const p = svc.createProject({ name: 'v', rootPath: root });

  // neither field
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/projects/${p.id}`, payload: {} })).statusCode, 400);
  // empty name
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/projects/${p.id}`, payload: { name: '' } })).statusCode, 400);
  // relative path
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/projects/${p.id}`, payload: { rootPath: 'relative/dir' } })).statusCode, 400);
  // absolute but nonexistent
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/projects/${p.id}`, payload: { rootPath: join(tmpdir(), 'cbw-nope-' + Date.now()) } })).statusCode, 400);
  // a rejected PATCH leaves the row unchanged
  assert.equal(svc.getProject(p.id).name, 'v');
  // name-only patch keeps rootPath
  const only = (await app.inject({ method: 'PATCH', url: `/api/projects/${p.id}`, payload: { name: 'v2' } })).json();
  assert.equal(only.name, 'v2');
  assert.equal(only.rootPath, root);
});
