import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TurnScheduler, QueueCancelled, CapacityUnavailable } from '../dist/turn-scheduler.js';
const tick = () => new Promise(r => setImmediate(r));

test('synchronous nested fork admission refuses a full pool instead of waiting for its parent', async () => {
  const pool = new TurnScheduler(1, 1);
  let release;
  const parent = pool.submit({ branchId: 'parent', projectId: 'p', workspace: 'parent', run: () => new Promise(r => release = r) });
  await tick();
  await assert.rejects(pool.submitImmediate({ branchId: 'child', projectId: 'p', workspace: 'child', run: async () => assert.fail('full pool started fork') }), CapacityUnavailable);
  assert.deepEqual(pool.snapshot().queued, []);
  release(); await parent; await pool.drain();
  await pool.submitImmediate({ branchId: 'child', projectId: 'p', workspace: 'child', run: async () => {} });
});

test('pool bounds concurrency, serializes shared files, lets other workspaces proceed', async () => {
  const pool = new TurnScheduler(2, 2);
  const started = []; const releases = new Map();
  const submit = (id, workspace) => pool.submit({ branchId: id, projectId: 'p', workspace,
    run: async () => { started.push(id); await new Promise(r => releases.set(id, r)); } });
  const a = submit('a', 'shared'); const b = submit('b', 'shared'); const c = submit('c', 'isolated');
  await tick(); assert.deepEqual(started, ['a', 'c']);
  assert.deepEqual(pool.snapshot().queued, ['b']);
  releases.get('a')(); await a; await tick(); assert.deepEqual(started, ['a', 'c', 'b']);
  releases.get('b')(); releases.get('c')(); await Promise.all([b, c]);
  assert.equal(await pool.drain(), true);
});

test('queued cancellation never runs task, shutdown rejects new work and drains active work', async () => {
  const pool = new TurnScheduler(1, 1); let release;
  const a = pool.submit({ branchId: 'a', projectId: 'p', workspace: 'a', run: () => new Promise(r => release = r) });
  await tick();
  const b = pool.submit({ branchId: 'b', projectId: 'p', workspace: 'b', run: async () => assert.fail('cancelled task ran') });
  const rejected = assert.rejects(b, QueueCancelled);
  assert.equal(pool.cancelQueued('b'), true); await rejected;
  pool.close(); await assert.rejects(pool.submit({ branchId: 'c', projectId: 'p', workspace: 'c', run: async () => {} }), /shutting down/);
  release(); await a; assert.equal(await pool.drain(), true);
});

for (const count of [5, 10, 20, 40]) test(`scheduler stress ${count} simulated sessions preserves bounds and completes all`, async () => {
  const pool = new TurnScheduler(5, 3); let active = 0, peak = 0, completed = 0;
  await Promise.all(Array.from({ length: count }, (_, i) => pool.submit({ branchId: String(i), projectId: 'p' + i % 2,
    workspace: 'w' + i, run: async () => { peak = Math.max(peak, ++active); await tick(); --active; ++completed; } })));
  assert.equal(completed, count); assert.ok(peak <= 5); assert.ok(peak > 1); assert.equal(await pool.drain(), true);
});
