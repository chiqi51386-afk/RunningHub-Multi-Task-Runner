import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {optimizeH3} from '../src/core/gemini/h3Optimizer.js';
import {WorkflowSkillStore} from '../src/core/gemini/workflowSkills.js';
import {RunningHubBackend} from '../src/core/index.js';
import {NullLogger} from '../src/core/logger.js';

test('workflow Skills persist independently, snapshot at submit, run exactly one stage',async()=>{
 const backend=new RunningHubBackend({databasePath:':memory:',logger:new NullLogger()});
 try{
  const workflow=backend.workflows.importPortablePackage(JSON.parse(readFileSync('bundled-workflows/minimax-h3-sharp.rhworkflow.json','utf8')));
  const store=new WorkflowSkillStore(backend.database.raw),id=workflow.runningHubWorkflowId;
  const custom=store.import(id,'test.md','Custom only: rewrite faithfully.');
  assert.notEqual(custom.selectedId,'builtin');
  assert.equal(store.settings('2106994828660080641').selectedId,'builtin');
  assert.throws(()=>store.select('2106994828660080641',custom.selectedId));
  assert.throws(()=>store.import(id,'bad.md',''));
  assert.throws(()=>store.import(id,'bad.md','x'.repeat(256*1024+1)));
  assert.throws(()=>store.settings('2100933451562491906'));
  const parameters=Object.fromEntries(workflow.profile.parameters.map(p=>[p.id,p.defaultValue]));parameters.prompt='原文';
  const skill=store.snapshot(id,false);
  const job=backend.jobs.create({workflowId:workflow.id,parameters,promptOptimization:{model:'gemini-test',skill,originalText:'原文'}});
  store.select(id,'builtin');
  assert.equal(job.profileSnapshot.promptOptimization?.skill?.content,skill.content);
  workflow.profile=job.profileSnapshot;
  let calls=0;
  const result=await optimizeH3(workflow,{workflowId:workflow.id,parameters},{generate:async input=>{
    calls++;assert.ok(input.systemInstruction?.startsWith(skill.content));
    assert.ok(!input.systemInstruction?.includes('Required H3 reference'));
    assert.equal(JSON.parse(input.text).userRequest,'原文');return {text:'优化结果',model:'gemini-test',keyId:'test'};
  }},async()=>{throw Error('no images');},undefined,'gemini-test');
  assert.equal(calls,1);assert.equal(result.text,'优化结果');
  assert.equal(workflow.profile.promptOptimization?.originalText,'原文');
  assert.equal(workflow.profile.promptOptimization?.finalText,'优化结果');
 }finally{await backend.close();}
});
