import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setupService,makeProject,makeRoot} from './helpers.mjs';
import {runTurnOnce} from '../dist/turn-runner.js';

async function run(t, raw, {interrupted=false,throwAfter=false}={}) {
  const {svc,bus,close}=setupService(); t.after(close);
  const branch=makeRoot(svc,makeProject(svc).id);
  const node=svc.openTurn({branchId:branch.id,userContent:'go'});
  const adapter={wasInterrupted:()=>interrupted,async *sendMessage(){yield* raw;if(throwAfter)throw new Error('crashed');}};
  const outcome=await runTurnOnce({svc,bus,adapter,sessionKey:'key',branchId:branch.id,nodeId:node.id,runtimeSessionId:null,text:'go'});
  return {...outcome,runs:svc.listAgentRunsByBranch(branch.id)};
}

test('persists distinct assistant messages including final answer after tools',async t=>{
  const {result}=await run(t,[{kind:'assistant',messageId:'m1',text:'Checking.'},{kind:'tool_use',name:'Read',input:{}},{kind:'assistant',messageId:'m2',text:'Final answer.'},{kind:'assistant',messageId:'m2',text:'Final answer.'},{kind:'assistant',messageId:'m3',text:'Final answer.'},{kind:'result',exitCode:0}]);
  assert.equal(result.assistantContent,'Checking.\nFinal answer.\nFinal answer.');
});
test('missing terminal is failed, never implicit cancellation; orphan runs close',async t=>{
  const {result,runs,events}=await run(t,[{kind:'init',externalSessionId:'ext'},{kind:'task',id:'worker',type:'task_started'}]);
  assert.equal(result.status,'failed');
  assert.ok(runs.length>=2);
  assert.ok(runs.every(r=>r.status==='failed'));
  assert.ok(events.some(e=>e.type==='session.stopped'&&e.status==='failed'));
});
test('thrown runtime error closes orphan main and worker runs',async t=>{
  const {result,runs}=await run(t,[{kind:'init',externalSessionId:'ext'},{kind:'task',id:'worker',type:'task_started'}],{throwAfter:true});
  assert.equal(result.status,'failed'); assert.ok(runs.every(r=>r.status==='failed'));
});
test('explicit interruption yields cancelled and includes terminal event',async t=>{
  const {result,events}=await run(t,[{kind:'init',externalSessionId:'ext'}],{interrupted:true});
  assert.equal(result.status,'cancelled'); assert.ok(events.some(e=>e.type==='session.stopped'&&e.status==='cancelled'));
});
