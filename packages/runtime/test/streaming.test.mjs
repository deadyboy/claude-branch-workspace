import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCliAdapter } from '../dist/index.js';

function fixture(t, body, timeout = 3000, persistence) {
  const dir = mkdtempSync(join(tmpdir(), 'cbw-stream-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(dir, 'cli.mjs');
  writeFileSync(script, `import {writeFileSync,readFileSync} from 'node:fs';
const emit = e => process.stdout.write(JSON.stringify(e)+'\\n');
const args = process.argv.slice(2);
${body}`);
  return { dir, adapter: new ClaudeCliAdapter(process.execPath, [script], persistence, timeout, timeout) };
}

test('assistant progress arrives before child exits, and interrupt retains it', async t => {
  const {dir, adapter} = fixture(t, `
emit({type:'system',subtype:'init',session_id:'ext'});
emit({type:'assistant',message:{id:'m1',content:[{type:'text',text:'working'}]}});
setTimeout(()=>{writeFileSync('finished','yes');emit({type:'result',is_error:false});},1800);`);
  const s = await adapter.resumeSession('ext', dir);
  const stream = adapter.sendMessage(s.sessionKey, {text:'go'})[Symbol.asyncIterator]();
  try {
    assert.equal((await stream.next()).value.kind, 'init');
    assert.equal((await stream.next()).value.text, 'working');
    assert.ok(!existsSync(join(dir,'finished')), 'events must arrive while CLI is still alive');
  } finally { await adapter.interrupt(s.sessionKey); await stream.return(); }
});

test('nonzero process exit and missing result fail without exposing stderr', async t => {
  const {dir, adapter} = fixture(t, `emit({type:'system',subtype:'init',session_id:'ext'});
process.stderr.write('SECRET_TOKEN='.repeat(100000)); process.exitCode=7;`);
  const s = await adapter.resumeSession('ext', dir);
  await assert.rejects(async () => { for await (const _ of adapter.sendMessage(s.sessionKey,{text:'go'})) {} }, e => /exit|result/i.test(e.message) && !e.message.includes('SECRET_TOKEN'));
});

test('startup requires successful terminal result, not only init', async t => {
  const {dir, adapter} = fixture(t, `emit({type:'system',subtype:'init',session_id:'ext'});`);
  await assert.rejects(adapter.startSession({sessionId:'root',cwd:dir,workspaceMode:'shared'}), /result|terminal/i);
});

test('reconstruction enforces zero tools, isolated memory and transcript roles', async t => {
  const {dir, adapter} = fixture(t, `
const settings = JSON.parse(args[args.indexOf('--settings')+1]);
writeFileSync('capture.json',JSON.stringify({args,settings,memory:process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY}));
emit({type:'system',subtype:'init',session_id:'ext'}); emit({type:'result',is_error:false});`);
  await adapter.reconstructBranchFromHistory({visibleMessages:[{role:'user',content:'old question'},{role:'assistant',content:'old answer'}]}, {newSessionId:'child',cwd:dir});
  const capture = JSON.parse(readFileSync(join(dir,'capture.json'),'utf8'));
  assert.ok(capture.args.includes('--tools'));
  assert.equal(capture.args[capture.args.indexOf('--tools')+1], '');
  assert.ok(capture.args.includes('--strict-mcp-config'));
  assert.equal(capture.args[capture.args.indexOf('--mcp-config')+1], '{"mcpServers":{}}');
  assert.equal(capture.settings.autoMemoryEnabled, false);
  assert.equal(existsSync(join(dir, '.cbw')), false, 'runtime settings must not dirty the workspace');
  assert.equal(capture.settings.env.ANTHROPIC_BASE_URL, adapter.gatewayAddress);
  assert.equal(capture.settings.env.ANTHROPIC_AUTH_TOKEN, undefined, 'session settings never persist credentials');
  assert.equal(capture.settings.disableAllHooks, true);
  assert.equal(capture.memory, '1');
  assert.ok(capture.args.some(x => x.includes('"role":"user"') && x.includes('"role":"assistant"')));
});

test('process crash after provisional successful result still fails', async t => {
  const {dir,adapter}=fixture(t, `emit({type:'system',subtype:'init',session_id:'ext'}); emit({type:'result',is_error:false}); process.exitCode=9;`);
  const s=await adapter.resumeSession('ext',dir);
  const observed=[];
  await assert.rejects(async()=>{for await(const e of adapter.sendMessage(s.sessionKey,{text:'go'}))observed.push(e);},/code 9/);
  assert.ok(!observed.some(e=>e.kind==='result'), 'provisional result cannot report success before exit');
});

test('returning early terminates a child with backpressured output', async t => {
  const {dir,adapter}=fixture(t, `emit({type:'system',subtype:'init',session_id:'ext'}); for(let n=0;n<2000;n++)emit({type:'assistant',message:{id:String(n),content:[{type:'text',text:'working'}]}}); setTimeout(()=>{},90000);`);
  const s=await adapter.resumeSession('ext',dir);
  const stream=adapter.sendMessage(s.sessionKey,{text:'go'})[Symbol.asyncIterator]();
  assert.equal((await stream.next()).value.kind,'init');
  await stream.return();
  assert.equal(adapter.wasInterrupted(s.sessionKey),false,'consumer return is not a user interrupt');
});

test('runtime never writes mappings with a fabricated branch id', async t => {
  let writes = 0;
  const {dir, adapter} = fixture(t, `emit({type:'system',subtype:'init',session_id:'ext'}); emit({type:'result',is_error:false});`, 3000,
    {getRuntimeSessionByExternalId:()=>null,upsertRuntimeSession:()=>{writes++;}});
  await adapter.reconstructBranchFromHistory({visibleMessages:[]}, {newSessionId:'session-not-branch',cwd:dir});
  assert.equal(writes, 0, 'SessionManager alone owns runtime_sessions writes');
});
