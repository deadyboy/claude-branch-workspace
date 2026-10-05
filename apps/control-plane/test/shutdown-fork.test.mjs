import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { setupService, fakeAdapter, makeProject, makeRoot } from './helpers.mjs';
import { SessionManager } from '../dist/session-manager.js';
import { ForkOrchestrator } from '../dist/fork-orchestrator.js';
import { TurnScheduler } from '../dist/turn-scheduler.js';
import { AttentionRegistry } from '../dist/attention-registry.js';
import { buildApp } from '../dist/server.js';

test('shutdown interrupts an eager fork before waiting for its HTTP response', { timeout: 5000 }, async () => {
  const { svc, repo, bus, close } = setupService();
  const base = fakeAdapter();
  let releaseSeed;
  const seedGate = new Promise(resolve => { releaseSeed = resolve; });
  let enteredSeed;
  const entered = new Promise(resolve => { enteredSeed = resolve; });
  const interruptedKeys = [];
  let seedKey;
  const adapter = {
    ...base,
    async reconstructBranchFromHistory(snapshot, input) {
      seedKey = input.newSessionId;
      enteredSeed();
      await seedGate;
      return base.reconstructBranchFromHistory(snapshot, input);
    },
    async interrupt(key) {
      interruptedKeys.push(key);
      releaseSeed();
    },
  };
  const sessionManager = new SessionManager(svc, adapter);
  const scheduler = new TurnScheduler(1, 1);
  const forkOrchestrator = new ForkOrchestrator(svc, sessionManager, adapter, undefined, scheduler);
  const app = await buildApp({ ctx: {
    db: null, svc, repo, bus, adapter, scheduler, sessionManager, forkOrchestrator,
    attention: new AttentionRegistry(),
  }, logger: false });
  let req;
  let shutdown;
  let deadline;
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const project = makeProject(svc);
    const parent = makeRoot(svc, project.id);
    const node = svc.appendCompletedTurn({ branchId: parent.id, userContent: 'remember', assistantContent: 'remembered' });
    const response = new Promise((resolve, reject) => {
      req = request(`${address}/api/branches`, { method: 'POST', agent: false,
        headers: { 'content-type': 'application/json', connection: 'close' } }, res => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
      req.end(JSON.stringify({ projectId: project.id, forkFromNodeId: node.id }));
    });
    // Attach a handler before shutdown can close the transport.
    const responseSettled = response.catch(error => error);
    await entered;
    shutdown = app.close();
    await Promise.race([
      shutdown,
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('shutdown waited for fork instead of interrupting it')), 2000); }),
    ]);
    assert.deepEqual(interruptedKeys, [seedKey]);
    assert.equal(scheduler.snapshot().closing, true);
    assert.deepEqual(scheduler.snapshot().running, []);
    const child = svc.listBranches(project.id).find(branch => branch.parentBranchId === parent.id);
    assert.equal(child.status, 'archived');
    assert.equal(sessionManager.hasActiveTurn(child.id), false);
    await responseSettled;
  } finally {
    clearTimeout(deadline);
    releaseSeed();
    req?.destroy();
    await (shutdown ?? app.close());
    close();
  }
});
