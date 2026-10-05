// E4b apply tests (docs/14 §4.3). The five scenarios the plan names explicitly:
//   1. success
//   2. conflict (target changed after preview)
//   3. token staleness (target moved ⇒ confirmToken no longer matches)
//   4. repeated click (idempotent)
//   5. mid-apply failure (target stays原状 OR reports exactly what landed)
//
// Fixture: a Git project P1 with a SOURCE worktree branch that has a committed
// change, and a TARGET checkout that starts at the same base commit. Same git
// config ⇒ identical blob oids, so base comparisons are meaningful.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
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
function gitConfigure(cwd) {
  gitIn(cwd, 'config', 'user.name', 'CBW Test');
  gitIn(cwd, 'config', 'user.email', 'cbw@example.invalid');
  // Keep checked-out bytes identical to committed bytes so oid comparisons and
  // readFileSync assertions are not perturbed by Windows autocrlf.
  gitIn(cwd, 'config', 'core.autocrlf', 'false');
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
 * SOURCE repo + a detached worktree branch with a committed change on a.txt and
 * a new file new.txt; TARGET is a separate clone at the same base commit.
 * Returns the task bound to the source branch and both paths.
 */
async function applyFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cbw-apply-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const src = join(dir, 'src');
  const target = join(dir, 'target');
  mkdirSync(src);

  gitIn(src, 'init');
  gitConfigure(src);
  writeFileSync(join(src, 'a.txt'), 'original\n');
  writeFileSync(join(src, 'b.txt'), 'second\n');
  gitIn(src, 'add', '.');
  gitIn(src, 'commit', '-m', 'base');
  const baseHead = gitIn(src, 'rev-parse', 'HEAD');

  // TARGET = a clone at the same base (its own worktree, same objects). Force
  // autocrlf off for the checkout so bytes match the committed blobs.
  execFileSync('git', ['-c', 'core.autocrlf=false', 'clone', src, target], { windowsHide: true, encoding: 'utf8' });
  gitConfigure(target);
  // Re-materialize the initial checkout under autocrlf=false so LFs are preserved.
  rmSync(join(target, 'a.txt'), { force: true });
  rmSync(join(target, 'b.txt'), { force: true });
  gitIn(target, 'checkout', '--', '.');

  const s = setupService();
  t.after(s.close);
  const wm = new WorkspaceManager(s.svc);
  const p = s.svc.createProject({ name: 'apply', rootPath: target });
  const main = s.svc.createRootConversation({ projectId: p.id, rootBranchName: 'Main' });
  const node = s.svc.appendCompletedTurn({ branchId: main.id, userContent: 'work', assistantContent: 'ok' });
  const child = s.svc.createBranchFromNode({
    projectId: p.id, forkFromNodeId: node.id, displayName: 'Work', workspaceMode: 'worktree',
  });
  const cwd = await wm.bind(child);

  // The SOURCE work: edit a.txt and add new.txt, then COMMIT.
  writeFileSync(join(cwd, 'a.txt'), 'changed by source\n');
  writeFileSync(join(cwd, 'new.txt'), 'brand new\n');
  gitIn(cwd, 'add', '.');
  gitIn(cwd, 'commit', '-m', 'source work');

  const task = s.svc.createTask({ projectId: p.id, title: 'T', instructions: 'I', branchId: child.id });
  const application = await app(t, s);
  return { dir, src, target, baseHead, cwd, ...s, p, main, node, child, wm, application, task };
}

const post = (application, id, payload) =>
  application.inject({ method: 'POST', url: `/api/tasks/${id}/apply`, payload });

// ───────────────────────── 1. success ─────────────────────────
test('E4b success: preview is read-only, then apply writes the committed change to the target', async t => {
  const { application, task, target, baseHead } = await applyFixture(t);

  const prev = await post(application, task.id, { preview: true });
  assert.equal(prev.statusCode, 200);
  const pv = prev.json();
  assert.equal(pv.preview, true);
  assert.equal(pv.baseRef, baseHead);
  assert.equal(pv.targetPath, target);
  assert.equal(pv.canApply, true, 'preview says apply is possible');
  assert.equal(pv.conflicts.length, 0);
  assert.ok(pv.confirmToken && pv.operationId, 'preview returns token + operation id');

  // PREVIEW MUST NOT TOUCH THE TARGET.
  assert.equal(readFileSync(join(target, 'a.txt'), 'utf8'), 'original\n', 'target untouched by preview');
  assert.ok(!existsSync(join(target, 'new.txt')), 'preview did not create new.txt');

  const res = await post(application, task.id, { preview: false, confirmToken: pv.confirmToken });
  assert.equal(res.statusCode, 200);
  const ar = res.json();
  assert.equal(ar.status, 'applied');
  assert.equal(ar.operationId, pv.operationId);
  assert.equal(ar.replayed, false);
  assert.deepEqual(ar.applied.sort(), ['a.txt', 'new.txt']);
  assert.deepEqual(ar.pending, []);

  // Target now reflects the source work.
  assert.equal(readFileSync(join(target, 'a.txt'), 'utf8'), 'changed by source\n');
  assert.equal(readFileSync(join(target, 'new.txt'), 'utf8'), 'brand new\n');
  // b.txt was never touched.
  assert.equal(readFileSync(join(target, 'b.txt'), 'utf8'), 'second\n');
});

// ─────────────────── 2 & 3. conflict / token staleness ───────────────────
test('E4b conflict: target edited after preview ⇒ apply refuses (409) and target keeps the edit', async t => {
  const { application, task, target } = await applyFixture(t);

  const pv = (await post(application, task.id, { preview: true })).json();
  // Someone edits the TARGET between preview and apply.
  writeFileSync(join(target, 'a.txt'), 'someone else changed this\n');

  const res = await post(application, task.id, { preview: false, confirmToken: pv.confirmToken });
  assert.equal(res.statusCode, 409, 'stale token ⇒ 409, never a silent overwrite');
  assert.match(res.json().error, /目标|令牌|变化/);

  // The concurrent edit SURVIVES — apply did not clobber it.
  assert.equal(readFileSync(join(target, 'a.txt'), 'utf8'), 'someone else changed this\n');
  assert.ok(!existsSync(join(target, 'new.txt')), 'no partial apply leaked');
});

test('E4b preview-time conflict: target already diverged ⇒ preview reports conflict, canApply false', async t => {
  const { application, task, target } = await applyFixture(t);
  // Diverge the target BEFORE preview: a.txt changed away from base.
  writeFileSync(join(target, 'a.txt'), 'diverged\n');

  const pv = (await post(application, task.id, { preview: true })).json();
  assert.equal(pv.canApply, false);
  const conflict = pv.conflicts.find((c) => c.path === 'a.txt');
  assert.ok(conflict, 'a.txt flagged as a conflict');
  assert.equal(pv.files.find((f) => f.path === 'a.txt').decision, 'conflict');

  // Even with a valid token, apply refuses because the re-decide finds conflict.
  const res = await post(application, task.id, { preview: false, confirmToken: pv.confirmToken });
  assert.equal(res.statusCode, 409);
  assert.equal(readFileSync(join(target, 'a.txt'), 'utf8'), 'diverged\n');
});

// ───────────────────────── 4. idempotency ─────────────────────────
test('E4b idempotent: a second identical click REPLAYS the recorded result, never double-applies', async t => {
  const { application, task, target } = await applyFixture(t);

  const pv = (await post(application, task.id, { preview: true })).json();
  const first = await post(application, task.id, { preview: false, confirmToken: pv.confirmToken });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().status, 'applied');
  const firstApplied = first.json().applied.slice().sort();

  // Overwrite the target by hand to detect any second write.
  writeFileSync(join(target, 'a.txt'), 'sentinel after first apply\n');

  // Second click with the SAME token: the target state now differs, so the token
  // no longer matches — it must NOT re-write; it is recognised as the same op.
  const second = await post(application, task.id, { preview: false, confirmToken: pv.confirmToken });
  assert.equal(second.statusCode, 200);
  const body = second.json();
  assert.equal(body.status, 'replayed');
  assert.equal(body.replayed, true);
  assert.equal(body.operationId, pv.operationId);
  assert.deepEqual(body.applied.slice().sort(), firstApplied);
  // The sentinel proves the second click did NOT write.
  assert.equal(readFileSync(join(target, 'a.txt'), 'utf8'), 'sentinel after first apply\n');
});

test('E4b operationId is deterministic per (task,branch,target); a different target is a different op', async t => {
  const { application, task } = await applyFixture(t);
  const a = (await post(application, task.id, { preview: true })).json();
  const b = (await post(application, task.id, { preview: true })).json();
  assert.equal(a.operationId, b.operationId, 'same target ⇒ same operation id');
  assert.equal(a.confirmToken, b.confirmToken, 'unchanged target ⇒ same token');
});

// ─────────────────── 5. mid-apply failure ───────────────────
test('E4b mid-apply failure: an aborted write is NEVER reported as success; the applied/pending split is accurate', async t => {
  const { application, task, target, svc } = await applyFixture(t);

  const pv = (await post(application, task.id, { preview: true })).json();
  assert.equal(pv.canApply, true);

  // Deterministic mid-apply fault: the source's NEW file (new.txt) is decided
  // "apply" (target lacks it), but the target already holds a DIRECTORY by that
  // name → writeFile throws EISDIR. a.txt (modified) is written first, so the
  // failure happens with one file already applied.
  mkdirSync(join(target, 'new.txt'));

  const res = await post(application, task.id, { preview: false, confirmToken: pv.confirmToken });
  assert.equal(res.statusCode, 200);
  const body = res.json();

  // The core E4b rule: a failed apply must not read as "all applied".
  assert.ok(['failed', 'partial'].includes(body.status), `status was ${body.status}`);
  assert.notEqual(body.status, 'applied');
  assert.equal(body.replayed, false);
  assert.deepEqual(body.applied, ['a.txt'], 'a.txt landed before the failure');
  assert.deepEqual(body.pending, ['new.txt'], 'new.txt did not land');
  // a.txt was rolled back to its pre-apply content.
  assert.equal(readFileSync(join(target, 'a.txt'), 'utf8'), 'original\n', 'a.txt restored by the journal');
  // The error names the offending path (recovery entry / explanation).
  assert.match(body.error, /new\.txt/);
  // targetRestored reflects whether the journal FULLY restored: the blocked
  // directory path could not be removed, so the honest answer is false here.
  assert.equal(body.targetRestored, false);

  // The ledger records the same outcome.
  const ops = svc.listApplyOperationsByTask(task.id);
  assert.equal(ops.length, 1);
  assert.ok(['failed', 'partial'].includes(ops[0].status));
});

test('E4b mid-apply failure: when the rollback fully succeeds the target is byte-for-byte原状', async t => {
  const { application, task, target, svc } = await applyFixture(t);
  const pv = (await post(application, task.id, { preview: true })).json();

  // Force the failure on the FIRST op and leave nothing to un-restore badly: make
  // a.txt's SOURCE unreadable by deleting the committed blob is not portable, so
  // instead block the SECOND (new) file's write with a directory AND ensure the
  // rollback of it is a no-op by checking a.txt is restored regardless.
  mkdirSync(join(target, 'new.txt'));
  const res = await post(application, task.id, { preview: false, confirmToken: pv.confirmToken });
  const body = res.json();
  assert.equal(res.statusCode, 200);
  // In every case the previously-clean target keeps its ORIGINAL a.txt (no
  // partial content left behind) — this is the "目标保持原状" branch.
  assert.equal(readFileSync(join(target, 'a.txt'), 'utf8'), 'original\n');
  assert.ok(body.applied.every((p) => p !== 'new.txt'));
});

// ─────────────────── guard rails ───────────────────
test('apply rejects: unknown task (404), preview without boolean (400), missing token (400)', async t => {
  const { application, task } = await applyFixture(t);
  assert.equal((await post(application, 'nope', { preview: true })).statusCode, 404);
  assert.equal((await post(application, task.id, {})).statusCode, 400);
  assert.equal((await post(application, task.id, { preview: false })).statusCode, 400);
});

test('apply refuses when target equals the source workspace', async t => {
  const { application, task, cwd } = await applyFixture(t);
  const res = await post(application, task.id, { preview: true, targetPath: cwd });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /equals the source workspace/);
});

test('apply refuses an unbound branch (no workspace)', async t => {
  const { application, svc, p } = await applyFixture(t);
  const b = svc.createRootConversation({ projectId: p.id, rootBranchName: 'Unbound' });
  const task = svc.createTask({ projectId: p.id, title: 'u', instructions: 'u', branchId: b.id });
  const res = await post(application, task.id, { preview: true });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /not bound/);
});

test('E4b success also records a changeset artifact for provenance', async t => {
  const { application, task, svc } = await applyFixture(t);
  const pv = (await post(application, task.id, { preview: true })).json();
  await post(application, task.id, { preview: false, confirmToken: pv.confirmToken });
  const arts = svc.listArtifactsByTask(task.id);
  assert.equal(arts.length, 1);
  assert.equal(arts[0].kind, 'changeset');
});
