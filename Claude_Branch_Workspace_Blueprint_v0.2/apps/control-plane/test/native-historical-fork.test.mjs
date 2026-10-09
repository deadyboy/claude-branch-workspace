import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setupService, makeProject, makeRoot, fakeAdapter } from './helpers.mjs';
import { SessionManager } from '../dist/session-manager.js';
import { ForkOrchestrator } from '../dist/fork-orchestrator.js';

function nativeAdapter(svc) {
  const adapter = fakeAdapter();
  const registered = new Map();
  adapter.resumeSession = async (externalSessionId, cwd) => {
    const row = svc.getRuntimeSessionByExternalId(externalSessionId);
    registered.set(row.id, externalSessionId);
    return { sessionKey: row.id, externalSessionId, cwd, running: false };
  };
  adapter.forkFromHistoricalNode = async (key, input) => {
    assert.ok(registered.has(key), 'source is registered after restart');
    adapter.calls.push(['nativeHistory', registered.get(key), input.runtimeMessageId, input.cwd]);
    const externalSessionId = randomUUID();
    registered.set(input.newSessionId, externalSessionId);
    return { sessionKey: input.newSessionId, externalSessionId, cwd: input.cwd, running: false,
      forkedFromExternalSessionId: registered.get(key),
      runtimeMessageIdMap: { [input.runtimeMessageId]: randomUUID() } };
  };
  return adapter;
}

function completed(svc, branchId, uuid = randomUUID()) {
  const node = svc.openTurn({ branchId, userContent: 'synthetic turn' });
  return svc.completeTurn(node.id, { status: 'completed', assistantContent: 'answer', runtimeAssistantMessageId: uuid });
}

function bind(svc, branchId) {
  const id = randomUUID();
  const externalSessionId = randomUUID();
  svc.upsertRuntimeSession({ id, branchId, externalSessionId, adapterType: 'claude-cli',
    status: 'running', lastSeenAt: new Date().toISOString() });
  return { id, externalSessionId };
}

test('native historical fork survives manager restart; child new turn forks using child UUID/session', async () => {
  const { svc, close } = setupService();
  try {
    const project = makeProject(svc);
    const parent = makeRoot(svc, project.id);
    const source = bind(svc, parent.id);
    const first = completed(svc, parent.id);
    completed(svc, parent.id); // source is genuinely historical
    let adapter = nativeAdapter(svc);
    let manager = new SessionManager(svc, adapter);
    const child = await new ForkOrchestrator(svc, manager, adapter).createFork({
      projectId: project.id, forkFromNodeId: first.id, cwd: 'synthetic-child-cwd',
    });
    assert.equal(child.strategy, 'native_historical_fork');
    assert.deepEqual(adapter.calls[0], ['nativeHistory', source.externalSessionId, first.runtimeAssistantMessageId, 'synthetic-child-cwd']);
    const childSession = svc.getRuntimeSession(child.sessionKey);
    assert.notEqual(childSession.externalSessionId, child.sessionKey, 'SDK chooses external ID independently');
    assert.ok(JSON.parse(childSession.metadataJson).runtimeMessageIdMap[first.runtimeAssistantMessageId]);
    assert.equal(JSON.parse(childSession.metadataJson).forkedFromExternalSessionId, source.externalSessionId);
    assert.equal(svc.getNode(first.id).runtimeAssistantMessageId, first.runtimeAssistantMessageId, 'parent anchor never overwritten');
    const childTurn = completed(svc, child.branch.id);

    adapter = nativeAdapter(svc); // fresh runtime registry and manager
    manager = new SessionManager(svc, adapter);
    const grandchild = await new ForkOrchestrator(svc, manager, adapter).createFork({
      projectId: project.id, forkFromNodeId: childTurn.id,
    });
    assert.equal(grandchild.strategy, 'native_historical_fork');
    assert.equal(grandchild.branch.parentBranchId, child.branch.id);
    assert.equal(adapter.calls[0][1], childSession.externalSessionId);
    assert.equal(adapter.calls[0][2], childTurn.runtimeAssistantMessageId);
    assert.deepEqual(grandchild.snapshot.ancestorNodeIds, [first.id, childTurn.id]);
  } finally { close(); }
});

test('an active parent can delegate from a completed UUID without losing its turn claim', async () => {
  const { svc, close } = setupService();
  try {
    const project = makeProject(svc), parent = makeRoot(svc, project.id);
    bind(svc, parent.id);
    const anchor = completed(svc, parent.id);
    const adapter = nativeAdapter(svc), manager = new SessionManager(svc, adapter);
    await manager.resolveSession({ branchId: parent.id, cwd: '.' });
    const active = svc.openTurn({ branchId: parent.id, userContent: 'delegate now' });
    manager.markNode(parent.id, active.id);
    const child = await new ForkOrchestrator(svc, manager, adapter).createFork({
      projectId: project.id, forkFromNodeId: anchor.id,
    });
    assert.equal(child.strategy, 'native_historical_fork');
    assert.equal(manager.getState(parent.id).nodeId, active.id);
    assert.equal(manager.hasActiveTurn(parent.id), true);
    assert.deepEqual(child.snapshot.ancestorNodeIds, [anchor.id]);
  } finally { close(); }
});

test('native copy failure archives child, releases reservations and never replays history', async () => {
  const { svc, close } = setupService();
  try {
    const project = makeProject(svc), parent = makeRoot(svc, project.id);
    bind(svc, parent.id);
    const anchor = completed(svc, parent.id);
    const adapter = nativeAdapter(svc), manager = new SessionManager(svc, adapter);
    adapter.forkFromHistoricalNode = async () => { throw new Error('unknown transcript boundary'); };
    await assert.rejects(new ForkOrchestrator(svc, manager, adapter).createFork({
      projectId: project.id, forkFromNodeId: anchor.id,
    }), /unknown transcript boundary/);
    const child = svc.listBranches(project.id).find(b => b.id !== parent.id);
    assert.equal(child.status, 'archived');
    assert.equal(svc.listRuntimeSessionsByBranch(child.id).length, 0);
    assert.equal(manager.hasActiveTurn(parent.id), false);
    assert.equal(manager.hasActiveTurn(child.id), false);
    assert.equal(adapter.calls.some(c => c[0] === 'reconstruct'), false);
  } finally { close(); }
});

test('cancel during disk fork does not adopt a child session or replay history', async () => {
  const { svc, close } = setupService();
  try {
    const project = makeProject(svc), parent = makeRoot(svc, project.id);
    bind(svc, parent.id);
    const anchor = completed(svc, parent.id);
    const adapter = nativeAdapter(svc), manager = new SessionManager(svc, adapter);
    const originalFork = adapter.forkFromHistoricalNode;
    let terminated = null;
    adapter.terminate = async key => { terminated = key; };
    adapter.forkFromHistoricalNode = async (...args) => {
      const session = await originalFork(...args);
      const child = svc.listBranches(project.id).find(b => b.id !== parent.id);
      await manager.interrupt(child.id);
      return session;
    };
    await assert.rejects(new ForkOrchestrator(svc, manager, adapter).createFork({
      projectId: project.id, forkFromNodeId: anchor.id,
    }), /cancelled/);
    const child = svc.listBranches(project.id).find(b => b.id !== parent.id);
    assert.equal(child.status, 'archived');
    assert.ok(terminated);
    assert.equal(svc.listRuntimeSessionsByBranch(child.id).length, 0);
    assert.equal(manager.hasActiveTurn(child.id), false);
  } finally { close(); }
});

test('legacy nodes without UUID retain explicit reconstruction strategy', async () => {
  const { svc, close } = setupService();
  try {
    const project = makeProject(svc), parent = makeRoot(svc, project.id);
    bind(svc, parent.id);
    const anchor = completed(svc, parent.id, null);
    completed(svc, parent.id, null);
    const adapter = nativeAdapter(svc), manager = new SessionManager(svc, adapter);
    const child = await new ForkOrchestrator(svc, manager, adapter).createFork({
      projectId: project.id, forkFromNodeId: anchor.id,
    });
    assert.equal(child.strategy, 'replay_reconstruction');
    assert.equal(adapter.calls[0][0], 'reconstruct');
  } finally { close(); }
});

test('parent pending registration rejects before creating a child', async () => {
  const { svc, close } = setupService();
  try {
    const project = makeProject(svc), parent = makeRoot(svc, project.id);
    bind(svc, parent.id);
    const anchor = completed(svc, parent.id);
    const adapter = nativeAdapter(svc), manager = new SessionManager(svc, adapter);
    manager.claimTurn(parent.id, randomUUID());
    await assert.rejects(new ForkOrchestrator(svc, manager, adapter).createFork({
      projectId: project.id, forkFromNodeId: anchor.id,
    }), /being prepared/);
    assert.equal(svc.listBranches(project.id).length, 1);
    assert.equal(manager.hasPendingClaim(parent.id), true);
  } finally { close(); }
});

test('parent advances during native copy without changing the frozen child cutoff', async () => {
  const { svc, close } = setupService();
  try {
    const project = makeProject(svc), parent = makeRoot(svc, project.id);
    bind(svc, parent.id);
    const anchor = completed(svc, parent.id);
    const adapter = nativeAdapter(svc), manager = new SessionManager(svc, adapter);
    await manager.resolveSession({ branchId: parent.id, cwd: '.' });
    const active = svc.openTurn({ branchId: parent.id, userContent: 'later turn' });
    manager.markNode(parent.id, active.id);
    const original = adapter.forkFromHistoricalNode;
    adapter.forkFromHistoricalNode = async (...args) => {
      svc.completeTurn(active.id, { status: 'completed', assistantContent: 'future', runtimeAssistantMessageId: randomUUID() });
      manager.release(parent.id);
      return original(...args);
    };
    const child = await new ForkOrchestrator(svc, manager, adapter).createFork({
      projectId: project.id, forkFromNodeId: anchor.id,
    });
    assert.equal(adapter.calls[0][2], anchor.runtimeAssistantMessageId);
    assert.deepEqual(child.snapshot.ancestorNodeIds, [anchor.id]);
    assert.equal(JSON.stringify(child.snapshot.visibleMessages).includes('future'), false);
    assert.equal(svc.getNode(active.id).status, 'completed');
  } finally { close(); }
});
