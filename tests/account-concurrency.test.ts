import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {RunningHubBackend} from '../src/core/index.js';
import {NullLogger} from '../src/core/logger.js';
import {InMemorySecretStore} from '../src/core/secretStore.js';

const definition={name:'concurrency',runningHubWorkflowId:'123456789012',workflow:{'1':{class_type:'Text',inputs:{text:'test'}}}};
async function waitFor(check:()=>boolean){const deadline=Date.now()+5000;while(!check()){if(Date.now()>deadline)throw Error('timeout');await new Promise(r=>setTimeout(r,10));}}

test('atomic slots limit three jobs, freeing one does not free siblings, lowering cap drains naturally',async()=>{
 const b=new RunningHubBackend({databasePath:':memory:',logger:new NullLogger()});
 try{
  const a=b.accounts.add('paid','test-key');b.accounts.setConcurrency(a.id,3);
  assert.throws(()=>b.accounts.setConcurrency(a.id,0));assert.throws(()=>b.accounts.setConcurrency(a.id,3.5));
  const w=b.workflows.importApiJson(definition);for(let i=0;i<6;i++)b.jobs.create({workflowId:w.id,parameters:{}});
  b.database.updateAccount(a.id,{state:'IDLE',coins:'100'});
  const jobs=[1,2,3].map(()=>b.database.claimNextJob(a.id)!);
  assert.ok(jobs.every(Boolean));assert.equal(b.database.claimNextJob(a.id),undefined);
  assert.equal(b.accounts.get(a.id)?.activeJobCount,3);
  b.database.updateJob(jobs[0]!.id,{status:'CANCELLED'});b.accounts.release(a.id,jobs[0]!.id,false);
  assert.equal(b.accounts.get(a.id)?.activeJobCount,2);assert.ok(b.accounts.get(a.id)?.currentJobId);
  assert.throws(()=>b.accounts.remove(a.id));assert.throws(()=>b.accounts.updateKey(a.id,'new-key'));
  b.accounts.setConcurrency(a.id,1);assert.equal(b.database.claimNextJob(a.id),undefined);
  b.accounts.setConcurrency(a.id,3);assert.ok(b.database.claimNextJob(a.id));
  b.database.updateJob(jobs[1]!.id,{status:'SUBMIT_UNKNOWN'});
  assert.equal(b.database.claimNextJob(a.id),undefined);
 }finally{await b.close();}
});

test('remote count subtracts known local tasks instead of double counting, remaining web occupancy is reserved',async()=>{
 let remote=2;
 const b=new RunningHubBackend({databasePath:':memory:',logger:new NullLogger(),fetch:async()=>Response.json({code:0,data:{remainMoney:'100',currentTaskCounts:remote}})});
 try{
  const a=b.accounts.add('paid','key');b.accounts.setConcurrency(a.id,3);
  const w=b.workflows.importApiJson(definition);for(let i=0;i<4;i++)b.jobs.create({workflowId:w.id,parameters:{}});
  b.database.updateAccount(a.id,{state:'IDLE'});
  const first=b.database.claimNextJob(a.id)!;
  b.database.updateJob(first.id,{status:'RUNNING',remoteTaskId:'remote-one'});
  await b.accounts.refresh(a.id);
  assert.equal(b.accounts.get(a.id)?.externalTaskCount,1);
  const second=b.database.claimNextJob(a.id)!;assert.ok(second);
  assert.equal(b.database.claimNextJob(a.id),undefined);
  b.database.updateJob(second.id,{status:'RUNNING',remoteTaskId:'remote-two'});
  remote=2;await b.accounts.refresh(a.id);
  assert.equal(b.accounts.get(a.id)?.externalTaskCount,0);
  assert.ok(b.database.claimNextJob(a.id));
 }finally{await b.close();}
});

test('one account runs exactly three remotely and fills a free slot before downloads complete',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'rh-concurrency-'));
 const tasks=new Map<string,boolean>();let count=0,peak=0;const done=new Set<string>();
 const fetcher:typeof fetch=async(input)=>{
  const url=String(input);
  if(url.endsWith('/accountStatus'))return Response.json({code:0,data:{remainMoney:'100',currentTaskCounts:[...tasks.values()].filter(Boolean).length}});
  if(url.includes('/run/workflow/')){const id='remote-'+(++count);tasks.set(id,true);peak=Math.max(peak,[...tasks.values()].filter(Boolean).length);return Response.json({code:0,data:{taskId:id}});}
  if(url.startsWith('https://files/'))return new Response('video');
  throw Error('unexpected '+url);
 };
 const b=new RunningHubBackend({databasePath:':memory:',logger:new NullLogger(),config:{pollIntervalMs:5,pollJitterMs:0,outputDir:dir},fetch:async(input,init)=>{
  if(String(input).endsWith('/query')){const {taskId}=JSON.parse(String(init?.body));if(done.has(taskId)){tasks.set(taskId,false);return Response.json({status:'SUCCESS',results:[{url:'https://files/'+taskId+'.mp4',outputType:'mp4'}]});}return Response.json({status:'RUNNING'});}
  return fetcher(input,init);
 }});
 try{
  const a=b.accounts.add('paid','key');b.accounts.setConcurrency(a.id,3);
  const w=b.workflows.importApiJson(definition);for(let i=0;i<5;i++)b.jobs.create({workflowId:w.id,parameters:{}});
  await b.start();await waitFor(()=>count===3);await new Promise(r=>setTimeout(r,80));assert.equal(count,3);
  done.add('remote-1');await waitFor(()=>count===4);assert.equal(peak,3);
  done.add('remote-2');done.add('remote-3');done.add('remote-4');await waitFor(()=>count===5);done.add('remote-5');
  await waitFor(()=>b.jobs.list().every(j=>j.status==='COMPLETED'));assert.equal(peak,3);assert.equal(b.accounts.get(a.id)?.activeJobCount,0);
 }finally{await b.close();await rm(dir,{recursive:true,force:true});}
});

test('restart retains all three reservations and the per-account cap',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'rh-slots-'));const databasePath=path.join(dir,'data.sqlite');
 const secretStore=new InMemorySecretStore();
 let b=new RunningHubBackend({databasePath,secretStore,logger:new NullLogger()});
 try{
  const a=b.accounts.add('paid','key');b.accounts.setConcurrency(a.id,3);
  const w=b.workflows.importApiJson(definition);for(let i=0;i<4;i++)b.jobs.create({workflowId:w.id,parameters:{}});
  b.database.updateAccount(a.id,{state:'IDLE'});
  for(let i=0;i<3;i++){const j=b.database.claimNextJob(a.id)!;b.database.updateJob(j.id,{status:i===2?'SUBMIT_UNKNOWN':'RUNNING',remoteTaskId:i===2?undefined:'r'+i});}
  await b.close();b=new RunningHubBackend({databasePath,secretStore,logger:new NullLogger()});
  assert.equal(b.accounts.get(a.id)?.maxConcurrency,3);assert.equal(b.accounts.get(a.id)?.activeJobCount,3);assert.equal(b.database.claimNextJob(a.id),undefined);
 }finally{await b.close();await rm(dir,{recursive:true,force:true});}
});
