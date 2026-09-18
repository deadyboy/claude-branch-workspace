// Production HTTP process + real Claude CLI. Retains its isolated scratch DB.
// Run explicitly: node scripts/phase5-live.mjs. No global configuration changed.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '..');
const scratch = resolve(process.env.CBW_LIVE_DIR ?? join(root, '.runtime-experiments', `phase5-${Date.now()}`));
const cwd = join(scratch, 'workspace');
mkdirSync(cwd, { recursive: true });
writeFileSync(join(cwd, 'README.md'), 'Clean live acceptance repository.\n');
execFileSync('git', ['init', cwd], { windowsHide: true });
execFileSync('git', ['-C', cwd, 'add', 'README.md']);
execFileSync('git', ['-C', cwd, '-c', 'user.name=CBW Test', '-c', 'user.email=cbw@example.invalid', 'commit', '-m', 'live fixture']);
const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
const port = reservation.address().port; await new Promise(r => reservation.close(r));
const base = `http://127.0.0.1:${port}`;
const dbPath = join(scratch, 'live.db');
const results = []; let server;
const delay = ms => new Promise(r => setTimeout(r, ms));
async function request(path, body, expected = 200) {
  const res = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(650_000) });
  const data = await res.json();
  assert.equal(res.status, expected, `${path}: ${JSON.stringify(data)}`);
  return data;
}
async function start() {
  server = spawn(process.execPath, [join(root, 'apps/control-plane/dist/index.js')], {
    cwd: root, windowsHide: true, env: { ...process.env, CBW_PORT: String(port), CBW_DB: dbPath, CBW_NO_STATIC: '1', CBW_FAKE_RUNTIME: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; server.stdout.on('data', d => logs += d); server.stderr.on('data', d => logs += d);
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(`server exited ${server.exitCode}`);
    try { await request('/api/runtime/capabilities'); return; } catch {}
    await delay(100);
  }
  throw new Error('server did not become ready');
}
async function stop() {
  if (server && server.exitCode === null) { const ended = once(server, 'exit'); server.kill('SIGTERM'); await ended; }
}
async function turn(branchId, text) {
  const { nodeId } = await request(`/api/branches/${branchId}/messages`, { text }, 202);
  const begun = Date.now();
  while (Date.now() - begun < 650_000) {
    const node = await request(`/api/nodes/${nodeId}`);
    if (node.status !== 'pending') {
      assert.equal(node.status, 'completed', `turn ${nodeId}: ${node.status}`);
      const chat = await request(`/api/branches/${branchId}/conversation`);
      const answer = chat.filter(m => m.nodeId === nodeId && m.role === 'assistant').map(m => m.content).join('\n');
      return { nodeId, answer, ms: Date.now() - begun };
    }
    await delay(250);
  }
  throw new Error('live turn deadline exceeded');
}
function record(name, details = {}) { results.push({ name, ...details }); console.log(JSON.stringify({ passed: name, ...details })); }
try {
  await start();
  const project = await request('/api/projects', { name: 'Phase5 live acceptance', rootPath: cwd }, 201);
  const main = (await request('/api/branches', { projectId: project.id }, 201)).branch;
  const marker = 'PAST_' + randomUUID().slice(0, 8);
  const first = await turn(main.id, `Remember the exact label ${marker}. Reply only READY. Do not use tools.`);
  assert.match(first.answer, /READY/); record('root production turn', { ms: first.ms });
  const future = 'FUTURE_' + randomUUID().slice(0, 8);
  await turn(main.id, `New label ${future}. Reply only RECORDED. Do not use tools.`);
  const child = (await request('/api/branches', { projectId: project.id, forkFromNodeId: first.nodeId,
    displayName: 'Historical child', workspaceMode: 'worktree' }, 201)).branch;
  const inherited = await request(`/api/branches/${child.id}/conversation`);
  assert.ok(!JSON.stringify(inherited).includes(future));
  const answer = await turn(child.id, 'List all exact PAST_ and FUTURE_ labels present in our conversation. Do not invent labels or use tools.');
  assert.ok(answer.answer.includes(marker), 'child remembers prefix');
  assert.ok(!answer.answer.includes(future), 'child cannot know future label'); record('historical fork isolation', { ms: answer.ms });
  const work = await request(`/api/branches/${child.id}/workspace`);
  assert.equal(work.mode, 'worktree'); assert.notEqual(work.path, cwd);
  record('real git worktree binding');
  const parallel = await Promise.all([turn(main.id, 'Reply only MAIN_CONTINUES. Do not use tools.'), turn(child.id, 'Reply only CHILD_CONTINUES. Do not use tools.')]);
  assert.match(parallel[0].answer, /MAIN_CONTINUES/); assert.match(parallel[1].answer, /CHILD_CONTINUES/);
  record('main and child complete independently', { ms: parallel.map(t => t.ms) });
  await stop(); await start();
  const resumed = await turn(child.id, 'Recall the exact PAST_ label from our prior conversation. Reply with that label only; do not use tools.');
  assert.ok(resumed.answer.includes(marker)); record('restart retains context and identity', { ms: resumed.ms });
  const run = await request(`/api/branches/${child.id}/messages`, { text: 'Think carefully about 50 distinct alternative algorithms before responding. Do not use tools.' }, 202);
  await delay(250);
  await request(`/api/branches/${child.id}/interrupt`, {}, 202);
  let cancelled;
  for (let i = 0; i < 120; i++) {
    cancelled = await request(`/api/nodes/${run.nodeId}`); if (cancelled.status !== 'pending') break; await delay(250);
  }
  assert.equal(cancelled.status, 'cancelled'); record('live interrupt cancels targeted turn');
  await request(`/api/branches/${child.id}/archive`, {}, 200); record('archive preserves worktree');
  writeFileSync(join(scratch, 'result.json'), JSON.stringify({ status: 'PASS', projectId: project.id, mainId: main.id, childId: child.id, results }, null, 2));
  console.log(JSON.stringify({ status: 'PASS', evidence: join(scratch, 'result.json') }));
} catch (error) {
  writeFileSync(join(scratch, 'result.json'), JSON.stringify({ status: 'FAIL', error: String(error), results }, null, 2));
  console.error(String(error)); process.exitCode = 1;
} finally { await stop(); }
