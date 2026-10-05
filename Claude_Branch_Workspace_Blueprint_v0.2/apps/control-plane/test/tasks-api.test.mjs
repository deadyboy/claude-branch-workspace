// S4 task routes (docs/14 §4.3). Asserts the frozen shapes and the E5 rules:
// create/list/get, cross-project branch rejection, editable title/role, and
// retry retention (old attempts survive a retry). POST /api/tasks/:id/apply is
// deliberately absent here — that is the separate E4b unit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
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
  t.after(async () => { await app.close(); s.close(); });
  return { ...s, app };
}

test('POST /api/tasks creates (201), GET /api/projects/:id/tasks lists', async t => {
  const { app, svc } = await setup(t);
  const p = svc.createProject({ name: 'p' });

  const created = await app.inject({ method: 'POST', url: '/api/tasks', payload: { projectId: p.id, title: 'T', instructions: 'I' } });
  assert.equal(created.statusCode, 201);
  const task = created.json();
  assert.equal(task.projectId, p.id);
  assert.equal(task.title, 'T');
  assert.equal(task.instructions, 'I');
  assert.equal(task.branchId, null);
  assert.equal(task.status, 'queued');

  const list = await app.inject(`/api/projects/${p.id}/tasks`);
  assert.equal(list.statusCode, 200);
  assert.deepEqual(list.json().map(x => x.id), [task.id]);
});

test('POST /api/tasks validates required fields', async t => {
  const { app, svc } = await setup(t);
  const p = svc.createProject({ name: 'p' });
  assert.equal((await app.inject({ method: 'POST', url: '/api/tasks', payload: { title: 't', instructions: 'i' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/tasks', payload: { projectId: p.id, instructions: 'i' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/tasks', payload: { projectId: p.id, title: 't' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/tasks', payload: { projectId: 'nope', title: 't', instructions: 'i' } })).statusCode, 404);
});

test('POST /api/tasks rejects a branch from another project', async t => {
  const { app, svc } = await setup(t);
  const a = svc.createProject({ name: 'a' });
  const b = svc.createProject({ name: 'b' });
  const branchA = svc.createRootConversation({ projectId: a.id, rootBranchName: 'A' });

  const res = await app.inject({ method: 'POST', url: '/api/tasks', payload: { projectId: b.id, title: 't', instructions: 'i', branchId: branchA.id } });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /belongs to project/);

  // same project → accepted and bound
  const ok = await app.inject({ method: 'POST', url: '/api/tasks', payload: { projectId: a.id, title: 't', instructions: 'i', branchId: branchA.id } });
  assert.equal(ok.statusCode, 201);
  assert.equal(ok.json().branchId, branchA.id);
});

test('GET /api/tasks/:id returns the task with its attempts (404 when unknown)', async t => {
  const { app, svc } = await setup(t);
  const p = svc.createProject({ name: 'p' });
  const task = svc.createTask({ projectId: p.id, title: 'T', instructions: 'I' });
  svc.addTaskAttempt({ taskId: task.id });

  const res = await app.inject(`/api/tasks/${task.id}`);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.id, task.id);
  assert.ok(Array.isArray(body.attempts));
  assert.equal(body.attempts.length, 1);

  assert.equal((await app.inject('/api/tasks/missing')).statusCode, 404);
});

test('E5 retry over HTTP: old attempt retained, new attempt appended, status aggregates', async t => {
  const { app, svc } = await setup(t);
  const p = svc.createProject({ name: 'p' });
  const task = svc.createTask({ projectId: p.id, title: 'Flaky', instructions: 'run' });

  const a1 = await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/attempts`, payload: {} });
  assert.equal(a1.statusCode, 201);
  const att1 = a1.json();

  const done1 = await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/attempts/${att1.id}/complete`, payload: { status: 'failed', error: 'boom' } });
  assert.equal(done1.statusCode, 200);
  assert.equal(done1.json().status, 'failed');

  // retry
  const a2 = await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/attempts`, payload: {} });
  const att2 = a2.json();
  assert.notEqual(att2.id, att1.id);
  const done2 = await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/attempts/${att2.id}/complete`, payload: { status: 'completed', resultRef: 'r1' } });
  assert.equal(done2.statusCode, 200);

  const body = (await app.inject(`/api/tasks/${task.id}`)).json();
  assert.equal(body.attempts.length, 2);
  assert.equal(body.attempts[0].status, 'failed');   // old record intact
  assert.equal(body.attempts[0].error, 'boom');
  assert.equal(body.attempts[1].status, 'completed');
  assert.equal(body.status, 'completed');            // aggregate = most recent attempt
});

test('PATCH /api/tasks/:id edits title / role / instructions (E5 editable)', async t => {
  const { app, svc } = await setup(t);
  const p = svc.createProject({ name: 'p' });
  const task = svc.createTask({ projectId: p.id, title: 'old', instructions: 'old-i' });

  const res = await app.inject({ method: 'PATCH', url: `/api/tasks/${task.id}`, payload: { title: 'new', role: 'reviewer' } });
  assert.equal(res.statusCode, 200);
  const updated = res.json();
  assert.equal(updated.id, task.id);
  assert.equal(updated.title, 'new');
  assert.equal(updated.role, 'reviewer');
  assert.equal(updated.instructions, 'old-i');

  assert.equal((await app.inject({ method: 'PATCH', url: `/api/tasks/${task.id}`, payload: {} })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/tasks/${task.id}`, payload: { title: '' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/tasks/missing', payload: { title: 'x' } })).statusCode, 404);
});
