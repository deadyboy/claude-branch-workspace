import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {readFileContent,resolveSafeFile,MAX_CONTENT_BYTES} from '../dist/file-content.js';
import {buildProjectGraph} from '../dist/project-graph.js';
import {setupService} from './helpers.mjs';
function tree(t) { mkdirSync('F:/CodexTemp',{recursive:true}); const root=mkdtempSync('F:/CodexTemp/cbw-content-'); t.after(()=>rmSync(root,{recursive:true,force:true}));return root; }
test('bounded content preserves UTF8 and represents missing/binary files',async t=>{
 const root=tree(t);writeFileSync(join(root,'text.txt'),'正文😀');writeFileSync(join(root,'binary.bin'),Buffer.from([1,0,2]));writeFileSync(join(root,'large.txt'),'文'.repeat(MAX_CONTENT_BYTES));
 assert.equal((await readFileContent(root,'text.txt')).content,'正文😀');assert.equal((await readFileContent(root,'missing.txt')).exists,false);
 const bin=await readFileContent(root,'binary.bin');assert.equal(bin.binary,true);assert.equal(bin.content,null);
 const large=await readFileContent(root,'large.txt');assert.equal(large.truncated,true);assert.ok(Buffer.byteLength(large.content)<=MAX_CONTENT_BYTES);assert.ok(!large.content.includes('�'));
});
test('path traversal, absolute paths, credential names and symlink escapes are refused',async t=>{
 const root=tree(t),outside=tree(t);writeFileSync(join(root,'.env'),'SYNTHETIC_SECRET');writeFileSync(join(outside,'private.txt'),'outside');
 for(const path of ['../outside.txt','F:/absolute.txt','.env','.git/config','secret.key','x:ads']) await assert.rejects(resolveSafeFile(root,path));
 try { symlinkSync(outside,join(root,'escape'),'junction'); } catch(e) { if(['EPERM','EACCES','ENOTSUP'].includes(e.code)) {t.diagnostic(`junction capability unavailable: ${e.code}`);return;}throw e; }
 await assert.rejects(readFileContent(root,'escape/private.txt'),/escapes/);
});
test('artifact graph deduplicates root files and resolves worktree file to its branch',async t=>{
 const root=tree(t),workspace=tree(t),s=setupService();t.after(s.close);writeFileSync(join(root,'same.txt'),'root');writeFileSync(join(workspace,'same.txt'),'worker');writeFileSync(join(root,'.env'),'SECRET');
 const p=s.svc.createProject({name:'p',rootPath:root}),b=s.svc.createRootConversation({projectId:p.id,rootBranchName:'worker'});s.svc.bindBranchWorkspace(b.id,{mode:'worktree',path:workspace});
 s.svc.createArtifact({projectId:p.id,kind:'file',path:'same.txt'});s.svc.createArtifact({projectId:p.id,originBranchId:b.id,kind:'file',path:'same.txt'});s.svc.createArtifact({projectId:p.id,kind:'file',path:'.env'});
 const graph=await buildProjectGraph(s.svc,p.id);assert.equal(graph.nodes.length,new Set(graph.nodes.map(n=>n.id)).size);
 const work=graph.nodes.find(n=>n.kind==='file'&&n.branchId===b.id);assert.equal(work.exists,true);assert.equal(work.path,'same.txt');
 assert.equal(graph.nodes.find(n=>n.id==='file:.env').exists,false);assert.equal((await readFileContent(workspace,work.path)).content,'worker');
 const ids=new Set(graph.nodes.map(n=>n.id));assert.ok(graph.edges.every(e=>ids.has(e.source)&&ids.has(e.target)));
});

test('project and branch HTTP content reads select the correct workspace',async t=>{
 const root=tree(t),workspace=tree(t),s=setupService();
 const {fakeAdapter}=await import('./helpers.mjs');const {SessionManager}=await import('../dist/session-manager.js');const {ForkOrchestrator}=await import('../dist/fork-orchestrator.js');const {AttentionRegistry}=await import('../dist/attention-registry.js');const {buildApp}=await import('../dist/server.js');
 const adapter=fakeAdapter(),sessionManager=new SessionManager(s.svc,adapter);const app=await buildApp({ctx:{...s,adapter,sessionManager,forkOrchestrator:new ForkOrchestrator(s.svc,sessionManager,adapter),attention:new AttentionRegistry()}});await app.ready();t.after(async()=>{await app.close();s.close();});
 writeFileSync(join(root,'a.txt'),'root');writeFileSync(join(workspace,'a.txt'),'worker');const p=s.svc.createProject({name:'p',rootPath:root}),b=s.svc.createRootConversation({projectId:p.id,rootBranchName:'worker'});s.svc.bindBranchWorkspace(b.id,{mode:'worktree',path:workspace});
 const task=s.svc.createTask({projectId:p.id,branchId:b.id,title:'t',instructions:'i'}),node=s.svc.openTurn({branchId:b.id,userContent:'i'});s.svc.addTaskAttempt({taskId:task.id,nodeId:node.id,status:'running'});
 const declare=(nodeId,path)=>app.inject({method:'POST',url:`/api/branches/${b.id}/artifacts`,payload:{nodeId,path}});
 const artifact=(await declare(node.id,'a.txt')).json();assert.equal(artifact.originTaskId,task.id);assert.equal(artifact.originNodeId,node.id);
 assert.equal((await declare(node.id,'.env')).statusCode,403);assert.equal((await declare(node.id,'missing.txt')).statusCode,404);assert.equal((await declare('not-this-node','a.txt')).statusCode,400);
 assert.equal((await app.inject(`/api/projects/${p.id}/files/content?path=a.txt`)).json().content,'root');assert.equal((await app.inject(`/api/branches/${b.id}/files/content?path=a.txt`)).json().content,'worker');assert.equal((await app.inject(`/api/projects/${p.id}/files/content?path=../escape`)).statusCode,403);assert.equal((await app.inject(`/api/projects/${p.id}/files/content?path=.env`)).statusCode,403);
});
