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
  await app.ready(); t.after(async () => { await app.close(); s.close(); });
  return { ...s, app };
}

test('HTTP rejects foreign origins and rebinding hosts before writes; missing IDs are 404', async t => {
  const { app, svc } = await setup(t);
  for (const headers of [{ origin: 'https://malicious.invalid' }, { host: 'malicious.invalid' }]) {
    const response = await app.inject({ method: 'POST', url: '/api/projects', headers, payload: { name: 'forbidden' } });
    assert.equal(response.statusCode, 403);
  }
  assert.equal(svc.listProjects().length, 0);
  for (const path of ['/api/projects/missing', '/api/nodes/missing']) assert.equal((await app.inject(path)).statusCode, 404);
});

test('WebSocket replay includes more than one 1000-event page', async t => {
  const { app, svc } = await setup(t);
  const project = svc.createProject({ name: 'replay' }); const branch = svc.createRootConversation({ projectId: project.id });
  for (let i = 0; i < 1100; ++i) svc.recordEvent({ projectId: project.id, branchId: branch.id, nodeId: null,
    agentRunId: null, runtimeSessionId: null, type: 'session.started', status: null,
    occurredAt: new Date().toISOString(), receivedAt: new Date().toISOString(), payloadJsonRedacted: '{}' });
  const got = [];
  const ws = await app.injectWS(`/ws/projects/${project.id}/events`, { headers: { host: "localhost" } }, {
    onOpen: socket => socket.on('message', raw => got.push(JSON.parse(String(raw)))) });
  ws.send(JSON.stringify({ hello: { lastSeqRel: 0 } }));
  const deadline = Date.now() + 5000;
  while (got.length < 1100 && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
  assert.equal(got.length, 1100); assert.equal(got.at(-1).seqRel, 1100); ws.close();
});
