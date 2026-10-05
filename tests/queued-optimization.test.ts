import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {RunningHubBackend} from '../src/core/index.js';
import {NullLogger} from '../src/core/logger.js';
import {buildNodeInfoList} from '../src/core/workflows/nodeInfo.js';
import {selectOptimization} from '../src/core/gemini/selection.js';
import {H3_OPTIMIZATION_ROUTES} from '../src/core/gemini/routes.js';

const bundle=JSON.parse(readFileSync('bundled-workflows/minimax-h3-sharp.rhworkflow.json','utf8'));
test('mixed workflow batch freezes Gemini model and disables Qwen on every relevant API request',async()=>{
 const backend=new RunningHubBackend({databasePath:':memory:',logger:new NullLogger(),fetch:async()=>{throw Error('No network');}});
 try{
   const inputs=['minimax-h3-multi-reference','minimax-h3-selflift','minimax-h3-sharp'].map(name=>{
     const workflow=backend.workflows.importPortablePackage(JSON.parse(readFileSync(`${["ltx-2.3-digital-human","minimax-h3-multi-reference","minimax-h3-selflift"].includes(name)?"tests/fixtures/retired-workflows":"bundled-workflows"}/${name}.rhworkflow.json`,'utf8')));
     const parameters=Object.fromEntries(workflow.profile.parameters.map(p=>[p.id,p.defaultValue]));parameters.prompt=name;
     return {workflowId:workflow.id,parameters,promptOptimization:selectOptimization(workflow,parameters,true,true,'gemini-frozen')};
   });
   backend.scheduler.optimizePrompt=async job=>{assert.equal(job.profileSnapshot.promptOptimization?.model,'gemini-frozen');return {parameterId:'prompt',text:`FINAL ${job.workflowName}`};};
   const jobs=backend.jobs.createBatch(inputs);
   inputs.forEach(input=>{input.promptOptimization!.model='gemini-changed';input.parameters.prompt='edited';});
   await backend.start();await waitFor(()=>jobs.every(job=>backend.jobs.get(job.id)?.status==='PENDING'));
   for(const initial of jobs){
     const job=backend.jobs.get(initial.id)!;const route=H3_OPTIMIZATION_ROUTES[job.runningHubWorkflowId]!;
     const entries=buildNodeInfoList(job.profileSnapshot,job.parameters,job.media);
     assert.equal(entries.find(e=>`${e.nodeId}.${e.fieldName}`===route.prompt)?.fieldValue,`FINAL ${job.workflowName}`);
     if(route.qwen)assert.equal(entries.find(e=>e.nodeId==='328'&&e.fieldName==='value')?.fieldValue,false);
   }
 }finally{await backend.close();}
});
function setup(){
 const backend=new RunningHubBackend({databasePath:':memory:',logger:new NullLogger(),fetch:async()=>{throw Error('No network allowed');}});
 const workflow=backend.workflows.importPortablePackage(bundle);
 const input={workflowId:workflow.id,parameters:Object.fromEntries(workflow.profile.parameters.map(p=>[p.id,p.defaultValue])),promptOptimization:{model:'gemini-3.5-flash-lite'}};
 input.parameters.prompt='original';
 return {backend,input};
}
async function waitFor(check:()=>boolean){for(let n=0;n<200;n++){if(check())return;await new Promise(r=>setTimeout(r,5));}throw Error('timed out');}

test('batch snapshots optimize before account claim; only final prompt reaches node 247',async()=>{
 const {backend,input}=setup();
 try {
  const seen:string[]=[];
  backend.scheduler.optimizePrompt=async job=>{seen.push(String(job.parameters.prompt));assert.equal(job.accountId,undefined);assert.equal(job.profileSnapshot.promptOptimization?.model,'gemini-3.5-flash-lite');return {parameterId:'prompt',text:`optimized ${job.parameters.prompt}`};};
  const jobs=backend.jobs.createBatch([input,{...input,parameters:{...input.parameters,prompt:'second'}}]);
  input.parameters.prompt='edited later';
  assert.ok(jobs.every(j=>j.status==='OPTIMIZE_PENDING'));
  await backend.start();
  await waitFor(()=>jobs.every(j=>backend.jobs.get(j.id)?.status==='PENDING'));
  assert.deepEqual(seen,['original','second']);
  const result=backend.jobs.get(jobs[0]!.id)!;
  assert.equal(result.parameters.prompt,'optimized original');
  assert.equal(result.accountId,undefined);
  assert.ok(buildNodeInfoList(result.profileSnapshot,result.parameters,result.media).some(n=>n.nodeId==='247'&&n.fieldName==='text'&&n.fieldValue==='optimized original'));
 }finally{await backend.close();}
});
test('at most four queued optimizations run concurrently',async()=>{
 const {backend,input}=setup();let active=0,maxActive=0;const releases:(()=>void)[]=[];
 try{
  backend.scheduler.optimizePrompt=async job=>{active++;maxActive=Math.max(maxActive,active);await new Promise<void>(resolve=>releases.push(resolve));active--;return {parameterId:'prompt',text:`optimized ${job.id}`};};
  const jobs=backend.jobs.createBatch(Array.from({length:5},(_,i)=>({...input,parameters:{...input.parameters,prompt:`task ${i}`}})));
  await backend.start();await waitFor(()=>releases.length===4);assert.equal(maxActive,4);assert.equal(backend.jobs.get(jobs[4]!.id)?.status,'OPTIMIZE_PENDING');
  releases.shift()!();await waitFor(()=>releases.length===4);assert.equal(maxActive,4);
  while(releases.length)releases.shift()!();await waitFor(()=>jobs.every(job=>backend.jobs.get(job.id)?.status==='PENDING'));
 }finally{while(releases.length)releases.shift()!();await backend.close();}
});

test('optimization failure fails closed; queued cancellation skips optimizer',async()=>{
 const {backend,input}=setup();
 try {
  backend.scheduler.optimizePrompt=async()=>{throw Error('provider failure');};
  const [first,second]=backend.jobs.createBatch([input,input]);
  await backend.scheduler.cancel(second!.id);
  await backend.start();
  await waitFor(()=>backend.jobs.get(first!.id)?.status==='FAILED');
  assert.equal(backend.jobs.get(first!.id)?.lastError?.phase,'optimize');
  assert.equal(backend.jobs.get(first!.id)?.accountId,undefined);
  assert.equal(backend.jobs.get(second!.id)?.status,'CANCELLED');
 }finally{await backend.close();}
});

test('cancelling an active optimizer ignores its late result',async()=>{
 const {backend,input}=setup();
 let finish!:(v:{parameterId:string;text:string})=>void;
 try {
  backend.scheduler.optimizePrompt=()=>new Promise(resolve=>{finish=resolve;});
  const job=backend.jobs.create(input);
  await backend.start();
  await waitFor(()=>!!finish);
  await backend.scheduler.cancel(job.id);
  finish({parameterId:'prompt',text:'late result'});
  await new Promise(r=>setTimeout(r,10));
  assert.equal(backend.jobs.get(job.id)?.status,'CANCELLED');
  assert.equal(backend.jobs.get(job.id)?.parameters.prompt,'original');
 }finally{await backend.close();}
});

test('interrupted optimization resumes on scheduler restart; disabled stays ordinary',async()=>{
 const {backend,input}=setup();
 try {
  const ordinary=backend.jobs.create({...input,promptOptimization:undefined});
  assert.equal(ordinary.status,'PENDING');
  const job=backend.jobs.create(input);
  backend.jobs.transition(job.id,'OPTIMIZING');
  backend.scheduler.optimizePrompt=async()=>({parameterId:'prompt',text:'resumed'});
  await backend.start();
  await waitFor(()=>backend.jobs.get(job.id)?.status==='PENDING');
  assert.equal(backend.jobs.get(job.id)?.parameters.prompt,'resumed');
 }finally{await backend.close();}
});
