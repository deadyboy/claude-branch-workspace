// Explicit real-model capacity probe. Stops escalation on the first failure.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import assert from 'node:assert/strict';
const root = resolve(import.meta.dirname, '..');
const scratch = join(root, '.runtime-experiments', `capacity-${Date.now()}`);
mkdirSync(scratch, { recursive: true });
const stages = (process.env.CBW_CAPACITY_STAGES ?? '5,10,20').split(',').map(Number);
assert.ok(stages.every(n => Number.isInteger(n) && n > 0 && n <= 40));
const evidence = { status: 'RUNNING', stages: [] };
const delay = ms => new Promise(r => setTimeout(r, ms));
let server;
let serverLog = '';
try {
  for (const count of stages) {
    const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
    const port = reserve.address().port; await new Promise(r => reserve.close(r));
    const base = `http://127.0.0.1:${port}`;
    async function api(path, body) {
      const res = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
      assert.ok(res.ok, `${path}: HTTP ${res.status}`); return res.json();
    }
    serverLog = '';
    server = spawn(process.execPath, [join(root, 'apps/control-plane/dist/index.js')], { cwd: root, windowsHide: true,
      env: { ...process.env, CBW_PORT: String(port), CBW_DB: join(scratch, `stage-${count}.db`), CBW_NO_STATIC: '1',
        CBW_FAKE_RUNTIME: '0', CBW_MAX_CONCURRENT: String(count), CBW_PER_PROJECT: String(count) }, stdio: ['ignore', 'pipe', 'pipe'] });
    const collect = d => { serverLog = (serverLog + d).slice(-8000); };
    server.stdout.on('data', collect); server.stderr.on('data', collect);
    let ready = false;
    for (let i=0; i<100; i++) { try { await api('/api/runtime/capabilities'); ready=true; break; } catch { await delay(100); } }
    assert.ok(ready, 'production server must start');
    const project = await api('/api/projects', { name: `Capacity ${count}`, rootPath: scratch });
    const branches = [];
    for (let i=0; i<count; i++) branches.push((await api('/api/branches', { projectId: project.id, displayName: `Worker ${i}` })).branch);
    const begun = Date.now();
    const turns = await Promise.all(branches.map(async (b, i) => ({ branchId: b.id, marker: `CAPACITY_OK_${i}`,
      ...(await api(`/api/branches/${b.id}/messages`, { text: `Reply only CAPACITY_OK_${i}. Do not use any tools.` })) })));
    const stage = { count, peakRunning: 0, completed: 0, failed: 0, latencyMs: [], wallMs: 0 };
    evidence.stages.push(stage);
    const remaining = new Set(turns.map(t => t.nodeId));
    while (remaining.size && Date.now()-begun < 750000) {
      const state = await api('/api/runtime/scheduler');
      stage.peakRunning = Math.max(stage.peakRunning, state.running.length);
      assert.ok(state.running.length <= count);
      for (const turn of turns.filter(t => remaining.has(t.nodeId))) {
        const node = await api(`/api/nodes/${turn.nodeId}`);
        if (node.status === 'pending') continue;
        remaining.delete(turn.nodeId);
        if (node.status === 'completed') {
          const chat = await api(`/api/branches/${turn.branchId}/conversation`);
          if (chat.some(m => m.nodeId === turn.nodeId && m.role === 'assistant' && m.content.includes(turn.marker))) stage.completed++;
          else stage.failed++;
        } else stage.failed++;
        stage.latencyMs.push(Date.now()-begun);
      }
      if (remaining.size) await delay(500);
    }
    stage.wallMs = Date.now()-begun; stage.failed += remaining.size;
    writeFileSync(join(scratch, 'result.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(stage));
    const ended = once(server, 'exit'); server.kill('SIGTERM'); await ended; server = undefined;
    assert.equal(stage.failed, 0, `capacity ${count} failed; escalation stopped`);
    assert.equal(stage.completed, count);
    assert.equal(stage.peakRunning, count, 'must observe real overlapping production jobs');
  }
  evidence.status = 'PASS';
} catch (e) {
  evidence.status = 'FAIL'; evidence.error = String(e); evidence.cause = String(e.cause ?? '');
  evidence.serverExitCode = server?.exitCode; evidence.serverSignal = server?.signalCode;
  // This server emits no prompts, credentials, or assistant contents to these logs.
  evidence.serverLog = serverLog;
  process.exitCode = 1;
}
finally {
  if (server && server.exitCode === null) { const ended=once(server,'exit'); server.kill('SIGTERM'); await ended; }
  writeFileSync(join(scratch, 'result.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ status: evidence.status, evidence: join(scratch, 'result.json') }));
}
