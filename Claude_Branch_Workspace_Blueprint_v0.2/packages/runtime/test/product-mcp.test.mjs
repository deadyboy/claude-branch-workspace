import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ClaudeCliAdapter} from '../dist/index.js';
test('formal CLI invocation receives product MCP and IDs; bootstrap stays isolated',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'cbw-mcp-capture-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const script=join(dir,'cli.mjs');writeFileSync(script,`import {appendFileSync} from 'node:fs';appendFileSync('capture.jsonl',JSON.stringify(process.argv.slice(2))+'\\n');console.log(JSON.stringify({type:'system',subtype:'init',session_id:'ext'}));console.log(JSON.stringify({type:'result',is_error:false}));`);
 const config=JSON.stringify({mcpServers:{'cbw-control':{command:process.execPath,args:['synthetic-server'],env:{CBW_CONTROL_PLANE_URL:'http://127.0.0.1:19099'}}}});
 const adapter=new ClaudeCliAdapter(process.execPath,[script],undefined,3000,3000,()=>({mcpConfig:config,systemContext:'projectId=P branchId=B'}));
 const session=await adapter.startSession({sessionId:'key',cwd:dir,workspaceMode:'shared'});for await(const _ of adapter.sendMessage(session.sessionKey,{text:'work'})){}
 const [boot,run]=readFileSync(join(dir,'capture.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 assert.equal(boot[boot.indexOf('--mcp-config')+1],'{"mcpServers":{}}');assert.equal(run[run.indexOf('--mcp-config')+1],config);assert.equal(run[run.indexOf('--append-system-prompt')+1],'projectId=P branchId=B');assert.ok(run.includes('--strict-mcp-config'));
 assert.equal(boot[boot.indexOf('--tools')+1],'');assert.ok(!boot.includes('--allowedTools'));
 const allowed=run[run.indexOf('--allowedTools')+1].split(',');
 assert.deepEqual(allowed,[
  'create_branch_from_node','send_message','list_branches','get_branch_status',
  'interrupt_branch','archive_branch','query_execution_status','get_turn_result',
  'create_task','run_task','get_task','register_artifact',
 ].map(name=>`mcp__cbw-control__${name}`));
 assert.ok(allowed.every(name=>!name.includes('*')));
 assert.ok(!run.includes('--dangerously-skip-permissions'));
 assert.ok(!run.includes('--allow-dangerously-skip-permissions'));
 for(const args of [boot,run]){
  const settings=JSON.parse(args[args.indexOf('--settings')+1]);
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN,undefined);
  assert.ok(!args.some(arg=>arg.includes('CBW_AUTH_TOKEN')||arg.includes('ANTHROPIC_AUTH_TOKEN')));
 }
});

test('normal turns without product context do not gain MCP permissions',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'cbw-mcp-none-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const script=join(dir,'cli.mjs');writeFileSync(script,`import {appendFileSync} from 'node:fs';appendFileSync('capture.jsonl',JSON.stringify(process.argv.slice(2))+'\\n');console.log(JSON.stringify({type:'system',subtype:'init',session_id:'ext'}));console.log(JSON.stringify({type:'result',is_error:false}));`);
 const adapter=new ClaudeCliAdapter(process.execPath,[script],undefined,3000,3000);
 const session=await adapter.startSession({sessionId:'key',cwd:dir,workspaceMode:'shared'});for await(const _ of adapter.sendMessage(session.sessionKey,{text:'work'})){}
 const [boot,run]=readFileSync(join(dir,'capture.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 assert.equal(boot[boot.indexOf('--tools')+1],'');assert.equal(boot[boot.indexOf('--mcp-config')+1],'{"mcpServers":{}}');
 for(const option of ['--allowedTools','--mcp-config','--append-system-prompt','--strict-mcp-config'])assert.ok(!run.includes(option));
});
