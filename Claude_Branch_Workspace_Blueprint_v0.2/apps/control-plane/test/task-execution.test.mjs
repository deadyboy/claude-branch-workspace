import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupService, fakeAdapter } from './helpers.mjs';
import { SessionManager } from '../dist/session-manager.js';
import { ForkOrchestrator } from '../dist/fork-orchestrator.js';
import { AttentionRegistry } from '../dist/attention-registry.js';
import { TurnScheduler } from '../dist/turn-scheduler.js';
import { buildApp } from '../dist/server.js';
import { reconcileOnBoot } from '../dist/reconcile.js';
const pause = ms => new Promise(r => setTimeout(r, ms));
async function until(check) { for(let i=0;i<200;i++) { if(check()) return; await pause(5); } assert.fail('state did not settle'); }
async function setup(t, limit=3) {
  const s=setupService(), adapter=fakeAdapter();
  const original=adapter.sendMessage.bind(adapter), held=new Map(), interrupted=new Set();
  adapter.sendMessage=async function*(key,input) {
    if(input.text.startsWith('hold')) await new Promise(r=>held.set(key,r));
    if(interrupted.has(key)) return;
    if(input.text==='fail') { yield {kind:'init',externalSessionId:'fake'}; yield {kind:'result',exitCode:1}; return; }
    yield* original(key,input);
  };
  adapter.interrupt=async key=>{interrupted.add(key); held.get(key)?.();};
  adapter.wasInterrupted=key=>interrupted.has(key);
  const scheduler=new TurnScheduler(limit,limit), sessionManager=new SessionManager(s.svc,adapter);
  const app=await buildApp({ctx:{...s,adapter,scheduler,sessionManager,forkOrchestrator:new ForkOrchestrator(s.svc,sessionManager,adapter),attention:new AttentionRegistry()}});
  await app.ready(); t.after(async()=>{await app.close();s.close();});
  const project=s.svc.createProject({name:'synthetic'});
  const task=(instructions='hello',name='worker')=>{const branch=s.svc.createRootConversation({projectId:project.id,rootBranchName:name}); return s.svc.createTask({projectId:project.id,branchId:branch.id,title:name,instructions});};
  const run=id=>app.inject({method:'POST',url:`/api/tasks/${id}/run`,payload:{}});
  return {...s,app,adapter,scheduler,sessionManager,task,run,held};
}
test('task executes the ordinary runtime and retains failed attempt through retry',async t=>{
  const s=await setup(t), task=s.task('fail');
  const first=await s.run(task.id); assert.equal(first.statusCode,202);
  await until(()=>s.svc.getTask(task.id).status==='failed');
  const a=s.svc.listTaskAttempts(task.id)[0]; assert.equal(a.nodeId,first.json().nodeId); assert.ok(a.agentRunId); assert.equal(s.svc.getNode(a.nodeId).status,'failed');
  s.svc.updateTask(task.id,{instructions:'hello'});
  const retry=await s.run(task.id); assert.equal(retry.statusCode,202);
  await until(()=>s.svc.getTask(task.id).status==='completed');
  const attempts=s.svc.listTaskAttempts(task.id); assert.equal(attempts.length,2); assert.equal(attempts[0].status,'failed'); assert.equal(attempts[1].status,'completed');
  assert.notEqual(attempts[0].nodeId,attempts[1].nodeId);
  const artifact=s.svc.getArtifact(attempts[1].resultRef); assert.equal(artifact.originTaskId,task.id); assert.equal(artifact.originNodeId,attempts[1].nodeId); assert.equal(artifact.path,null);
  assert.ok(s.adapter.calls.some(c=>c[0]==='sendMessage'&&c[2]==='hello'));
});
test('parallel tasks reject duplicate delivery and isolate interrupt',async t=>{
  const s=await setup(t), a=s.task('hold-a'),b=s.task('hold-b');
  const [x,y]=await Promise.all([s.run(a.id),s.run(a.id)]); assert.deepEqual([x.statusCode,y.statusCode].sort(),[202,409]);
  assert.equal((await s.run(b.id)).statusCode,202);
  await until(()=>s.held.size===2); assert.equal(s.scheduler.snapshot().running.length,2);
  assert.equal((await s.app.inject({method:'POST',url:`/api/branches/${a.branchId}/messages`,payload:{text:'duplicate'}})).statusCode,409);
  await s.app.inject({method:'POST',url:`/api/branches/${a.branchId}/interrupt`,payload:{}});
  await until(()=>s.svc.getTask(a.id).status==='cancelled'); assert.equal(s.svc.getTask(b.id).status,'running');
  const key=s.sessionManager.getState(b.branchId).sessionKey; s.held.get(key)();
  await until(()=>s.svc.getTask(b.id).status==='completed'); assert.equal(s.svc.listTaskAttempts(a.id).length,1);
});
test('queued cancellation, closed scheduler and startup failure become terminal',async t=>{
  const s=await setup(t,1), active=s.task('hold-active'),queued=s.task('queued');
  await s.run(active.id); await until(()=>s.held.size===1); await s.run(queued.id);
  await until(()=>s.scheduler.snapshot().queued.length===1); assert.equal(s.svc.getTask(queued.id).status,'queued');
  await s.app.inject({method:'POST',url:`/api/branches/${queued.branchId}/interrupt`,payload:{}});
  await until(()=>s.svc.getTask(queued.id).status==='cancelled');
  await s.app.inject({method:'POST',url:`/api/branches/${active.branchId}/interrupt`,payload:{}});
  await until(()=>s.scheduler.snapshot().running.length===0);
  s.adapter.startSession=async()=>{throw new Error('synthetic startup failure');}; const bad=s.task(); await s.run(bad.id);
  await until(()=>s.svc.getTask(bad.id).status==='failed'); assert.match(s.svc.listTaskAttempts(bad.id)[0].error,/startup/);
  s.scheduler.close(); const rejected=s.task(); await s.run(rejected.id);
  await until(()=>s.svc.getTask(rejected.id).status==='failed'); assert.equal(s.sessionManager.hasActiveTurn(rejected.branchId),false);
});
test('boot reconciliation closes durable running and queued attempts',async t=>{
  const s=await setup(t);
  for(const status of ['running','queued']) { const task=s.task();const node=s.svc.openTurn({branchId:task.branchId,userContent:'old'});s.svc.addTaskAttempt({taskId:task.id,nodeId:node.id,status}); }
  await reconcileOnBoot(s.svc);
  for(const task of s.svc.listTasksByProject(s.svc.listProjects()[0].id)) {assert.equal(task.status,'cancelled');assert.ok(s.svc.listTaskAttempts(task.id)[0].endedAt);}
});
