// S4 task persistence (docs/14 §5, E5). Covers: create/get/list, retry retention
// (a retry must append a NEW attempt and keep the old one — "重试不丢旧记录"),
// cross-project branch rejection, aggregate status, artifacts, and the
// migration's idempotency + old-data-readable guarantee.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newService } from './helpers.mjs';
import { openDb, Repository, DomainService, migrate, SCHEMA_VERSION } from '../dist/index.js';

function setup() {
  return newService();
}

test('createTask / getTask / listTasksByProject round-trips a task', () => {
  const { svc, close } = setup();
  const p = svc.createProject({ name: 'p' });
  const t = svc.createTask({ projectId: p.id, title: 'Implement', instructions: 'do the thing' });

  assert.equal(t.projectId, p.id);
  assert.equal(t.title, 'Implement');
  assert.equal(t.instructions, 'do the thing');
  assert.equal(t.branchId, null);            // no branch fabricated
  assert.equal(t.role, null);
  assert.equal(t.status, 'queued');          // default: waiting for a slot

  assert.deepEqual(svc.getTask(t.id), t);
  assert.deepEqual(svc.listTasksByProject(p.id).map((x) => x.id), [t.id]);
  assert.deepEqual(svc.listTasksByProject('other-project'), []);
  close();
});

test('createTask rejects unknown project, empty title/instructions, and cross-project branch', () => {
  const { svc, close } = setup();
  const a = svc.createProject({ name: 'a' });
  const b = svc.createProject({ name: 'b' });
  const branchA = svc.createRootConversation({ projectId: a.id, rootBranchName: 'A' });

  assert.throws(() => svc.createTask({ projectId: 'nope', title: 't', instructions: 'i' }), /not found/);
  assert.throws(() => svc.createTask({ projectId: a.id, title: '', instructions: 'i' }), /title/);
  assert.throws(() => svc.createTask({ projectId: a.id, title: 't', instructions: '' }), /instructions/);
  // branch belongs to project A, task claims project B → must be rejected.
  assert.throws(
    () => svc.createTask({ projectId: b.id, title: 't', instructions: 'i', branchId: branchA.id }),
    /belongs to project/
  );
  // same-project branch is accepted
  const ok = svc.createTask({ projectId: a.id, title: 't', instructions: 'i', branchId: branchA.id });
  assert.equal(ok.branchId, branchA.id);
  close();
});

test('E5 retry: a retry appends a NEW attempt and RETAINS the old one', () => {
  const { svc, close } = setup();
  const p = svc.createProject({ name: 'p' });
  const t = svc.createTask({ projectId: p.id, title: 'Flaky', instructions: 'run' });

  const a1 = svc.addTaskAttempt({ taskId: t.id });
  assert.equal(a1.status, 'running');
  assert.equal(svc.getTask(t.id).status, 'running'); // aggregate follows the live attempt

  const a1done = svc.completeTaskAttempt(a1.id, { status: 'failed', error: 'boom' });
  assert.equal(a1done.status, 'failed');
  assert.equal(a1done.error, 'boom');
  assert.ok(a1done.endedAt);
  assert.equal(svc.getTask(t.id).status, 'failed');

  // RETRY: new attempt row, old one untouched and still present.
  const a2 = svc.addTaskAttempt({ taskId: t.id });
  assert.notEqual(a2.id, a1.id);
  const attempts = svc.listTaskAttempts(t.id);
  assert.equal(attempts.length, 2, 'both attempts retained');
  assert.equal(attempts[0].id, a1.id);
  assert.equal(attempts[0].status, 'failed');   // old record NOT overwritten
  assert.equal(attempts[0].error, 'boom');
  assert.equal(attempts[1].id, a2.id);
  assert.equal(attempts[1].status, 'running');

  const a2done = svc.completeTaskAttempt(a2.id, { status: 'completed', resultRef: 'artifact-1' });
  assert.equal(a2done.resultRef, 'artifact-1');
  // Aggregate: most recent attempt wins → task reads completed, failure history intact.
  assert.equal(svc.getTask(t.id).status, 'completed');
  assert.equal(svc.listTaskAttempts(t.id).length, 2);
  close();
});

test('attempts inherit the task branch; explicit cross-project branch is rejected', () => {
  const { svc, close } = setup();
  const a = svc.createProject({ name: 'a' });
  const b = svc.createProject({ name: 'b' });
  const branchA = svc.createRootConversation({ projectId: a.id, rootBranchName: 'A' });
  const branchB = svc.createRootConversation({ projectId: b.id, rootBranchName: 'B' });
  const t = svc.createTask({ projectId: a.id, title: 't', instructions: 'i', branchId: branchA.id });

  const attempt = svc.addTaskAttempt({ taskId: t.id });
  assert.equal(attempt.branchId, branchA.id); // inherited

  assert.throws(() => svc.addTaskAttempt({ taskId: t.id, branchId: branchB.id }), /belongs to project/);
  close();
});

test('updateTask edits title/instructions/role without touching identity', () => {
  const { svc, close } = setup();
  const p = svc.createProject({ name: 'p' });
  const t = svc.createTask({ projectId: p.id, title: 'old', instructions: 'old-i' });

  const updated = svc.updateTask(t.id, { title: 'new', role: 'reviewer' });
  assert.equal(updated.id, t.id);
  assert.equal(updated.createdAt, t.createdAt);
  assert.equal(updated.title, 'new');
  assert.equal(updated.instructions, 'old-i'); // untouched
  assert.equal(updated.role, 'reviewer');

  assert.throws(() => svc.updateTask(t.id, { title: '' }), /title/);
  assert.throws(() => svc.updateTask('missing', { title: 'x' }), /not found/);
  close();
});

test('artifacts record provenance and reject a cross-project task origin', () => {
  const { svc, close } = setup();
  const a = svc.createProject({ name: 'a' });
  const b = svc.createProject({ name: 'b' });
  const t = svc.createTask({ projectId: a.id, title: 't', instructions: 'i' });

  const art = svc.createArtifact({ projectId: a.id, originTaskId: t.id, kind: 'report', path: 'out.md', summary: 'summary' });
  assert.equal(art.kind, 'report');
  assert.equal(art.originTaskId, t.id);
  assert.deepEqual(svc.listArtifacts(a.id).map((x) => x.id), [art.id]);
  assert.deepEqual(svc.listArtifactsByTask(t.id).map((x) => x.id), [art.id]);
  assert.deepEqual(svc.listArtifacts(b.id), []);

  assert.throws(() => svc.createArtifact({ projectId: b.id, originTaskId: t.id, kind: 'file' }), /belongs to project/);
  close();
});

test('migration: fresh DB reaches SCHEMA_VERSION and task tables exist', () => {
  const db = openDb(null);
  assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
    .all()
    .map((r) => r.name);
  for (const t of ['tasks', 'task_attempts', 'artifacts']) assert.ok(tables.includes(t), `missing ${t}`);
  db.close();
});

test('migration is idempotent and legacy rows survive (old DB readable)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cbw-task-mig-'));
  const path = join(dir, 'legacy.db');
  try {
    // 1. A DB that ran all migrations, with real data.
    let db = openDb(path);
    let repo = new Repository(db);
    let svc = new DomainService(repo);
    const p = svc.createProject({ name: 'legacy' });
    const t = svc.createTask({ projectId: p.id, title: 'keep', instructions: 'keep-i' });
    db.close();

    // 2. Re-open: migrate() runs again (no-op) — must not throw and version holds.
    db = openDb(path);
    assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
    repo = new Repository(db);
    svc = new DomainService(repo);
    assert.equal(svc.getProject(p.id).name, 'legacy');
    assert.equal(svc.getTask(t.id).title, 'keep');
    assert.equal(svc.listTasksByProject(p.id).length, 1);
    db.close();

    // 3. migrate() must be a true no-op on an already-current DB, no matter how
    //    many times it runs: old rows stay readable and the task tables remain
    //    usable. (A genuine pre-S4 DB is at user_version 3 without base_ref or
    //    the task tables, so v4/v5 apply cleanly on first upgrade — not simulated
    //    here, since re-running a non-idempotent ALTER cannot be faked safely.)
    db = openDb(path);
    migrate(db);
    migrate(db);
    assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
    repo = new Repository(db);
    svc = new DomainService(repo);
    assert.equal(svc.getProject(p.id).name, 'legacy');   // old row still readable
    assert.equal(svc.getTask(t.id).title, 'keep');        // pre-existing task intact
    const t2 = svc.createTask({ projectId: p.id, title: 'after', instructions: 'i' });
    assert.equal(svc.getTask(t2.id).title, 'after');      // new tables still usable
    db.close();
  } finally {
    // Best-effort: Windows may briefly hold the SQLite -wal/-shm handle after
    // close, so a transient EPERM on cleanup must not fail the test body.
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir, best-effort */ }
  }
});
