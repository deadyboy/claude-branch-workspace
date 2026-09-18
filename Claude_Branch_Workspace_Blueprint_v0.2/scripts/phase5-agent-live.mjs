// A real outer Claude agent uses stdio MCP to dispatch a real persistent child.
// Requires a successful scripts/phase5-live.mjs fixture. No client config edited.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { ClaudeCliAdapter } from '../packages/runtime/dist/index.js';
const root = resolve(import.meta.dirname, '..');
const fixtures = readdirSync(join(root, '.runtime-experiments')).filter(x => x.startsWith('phase5-')).sort();
const dir = process.env.CBW_ACCEPTANCE_DIR ?? join(root, '.runtime-experiments', fixtures.at(-1));
const fixture = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'));
assert.equal(fixture.status, 'PASS', 'requires successful live fixture');
const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
const port = reserve.address().port; await new Promise(r => reserve.close(r));
const base = `http://127.0.0.1:${port}`;
const wait = ms => new Promise(r => setTimeout(r, ms));
const server = spawn(process.execPath, [join(root, 'apps/control-plane/dist/index.js')], {
  cwd: root, windowsHide: true, env: { ...process.env, CBW_DB: join(dir, 'live.db'), CBW_PORT: String(port), CBW_NO_STATIC: '1', CBW_FAKE_RUNTIME: '0' }, stdio: 'ignore' });
let outer; const calls = [];
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/runtime/capabilities')).ok) break; } catch {} await wait(100); }
  const nodes = await (await fetch(base + `/api/branches/${fixture.mainId}/nodes`)).json();
  const head = nodes.filter(n => n.status === 'completed').at(-1);
  const config = { mcpServers: { cbw: { command: process.execPath, args: [join(root, 'apps/mcp-server/dist/index.js')], env: { CBW_CONTROL_PLANE_URL: base } } } };
  const adapter = new ClaudeCliAdapter();
  const cwd = join(dir, 'outer-agent'); mkdirSync(cwd, { recursive: true });
  const names = ['list_branches', 'create_branch_from_node', 'send_message', 'get_turn_result', 'get_branch_status'];
  const prompt = `You are the main coordinator in a real integration test. Use only the cbw MCP tools. First list_branches for projectId ${fixture.projectId}. Create exactly one persistent shared branch named Agent dispatched child from nodeId ${head.id} in that project. Send that child the message: Reply exactly AGENT_CHILD_OK; do not use tools. Then get_turn_result using the returned nodeId until terminal=true. If still pending, you may check get_branch_status between polls. Do not invent success: finish only when the tool result is completed and contains AGENT_CHILD_OK. Report the child branch ID and result. Never edit files or create additional branches.`;
  const args = ['--print', '--verbose', '--output-format', 'stream-json', '--tools', '', '--strict-mcp-config', '--mcp-config', JSON.stringify(config),
    '--allowedTools', ...names.map(n => `mcp__cbw__${n}`), '--max-turns', '20', '--settings', JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false,
      env: { ANTHROPIC_BASE_URL: adapter.gatewayAddress } }), prompt];
  outer = spawn('claude', args, { cwd, windowsHide: true, env: { ...adapter.env, MCP_TOOL_TIMEOUT: '650000' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = ''; let terminal = null;
  const timer = setTimeout(() => outer.kill('SIGTERM'), 650_000);
  outer.stderr.on('data', () => {});
  outer.stdout.on('data', chunk => {
    buf += chunk; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try {
        const e = JSON.parse(line);
        if (e.type === 'assistant') for (const b of e.message?.content ?? []) if (b.type === 'tool_use') {
          calls.push(b.name); console.log(JSON.stringify({ tool: b.name }));
        }
        if (e.type === 'result') terminal = { isError: e.is_error, subtype: e.subtype };
      } catch {}
    }
  });
  const [code] = await once(outer, 'exit'); clearTimeout(timer);
  assert.equal(code, 0); assert.equal(terminal?.isError, false);
  for (const tool of ['create_branch_from_node', 'send_message', 'get_turn_result']) assert.ok(calls.includes(`mcp__cbw__${tool}`), `${tool} actually called`);
  const branches = await (await fetch(base + `/api/projects/${fixture.projectId}/branches`)).json();
  const child = branches.filter(b => b.displayName === 'Agent dispatched child').at(-1); assert.ok(child);
  const conversation = await (await fetch(base + `/api/branches/${child.id}/conversation`)).json();
  assert.ok(conversation.some(m => m.origin === 'local' && m.role === 'assistant' && m.content.includes('AGENT_CHILD_OK')));
  const result = { status: 'PASS', outerAgent: 'real Claude CLI with configured model', innerRuntime: 'real Claude CLI',
    transport: 'stdio MCP -> HTTP production control plane', childId: child.id, calls, userVisibleViaRest: true };
  writeFileSync(join(dir, 'agent-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (err) {
  writeFileSync(join(dir, 'agent-result.json'), JSON.stringify({ status: 'FAIL', error: String(err), calls }, null, 2));
  console.error(String(err)); process.exitCode = 1;
} finally {
  for (const p of [outer, server]) if (p && p.exitCode === null) { const ended = once(p, 'exit'); p.kill('SIGTERM'); await ended; }
}
