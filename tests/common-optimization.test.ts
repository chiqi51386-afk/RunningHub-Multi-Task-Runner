import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parsePortableWorkflowPackage,materializePortableProfile} from '../src/core/workflows/package.js';
import {selectOptimization} from '../src/core/gemini/selection.js';
import {sharpInputs,optimizeH3} from '../src/core/gemini/h3Optimizer.js';
import {buildNodeInfoList} from '../src/core/workflows/nodeInfo.js';
import {createDraft,transferDraft,taskOptimizationEnabled} from '../frontend/src/task-draft.js';
import type {WorkflowRecord} from '../src/core/types.js';
import type {WorkflowView} from '../frontend/src/types.js';

function load(name:string){
 const pkg=parsePortableWorkflowPackage(JSON.parse(readFileSync(`${["ltx-2.3-digital-human","minimax-h3-multi-reference","minimax-h3-selflift"].includes(name)?"tests/fixtures/retired-workflows":"bundled-workflows"}/${name}.rhworkflow.json`,'utf8')));
 const profile=materializePortableProfile(pkg,name,1);
 const workflow:WorkflowRecord={id:name,name:pkg.workflow.name,runningHubWorkflowId:pkg.workflow.runningHubWorkflowId,raw:pkg.workflow.apiJson,workflowHash:pkg.workflow.workflowHash,profileVersion:1,profile,createdAt:0,updatedAt:0};
 const view={...workflow,parameters:profile.parameters,parameterCount:profile.parameters.length,needsReview:false} as WorkflowView;
 return {workflow,view,parameters:Object.fromEntries(profile.parameters.map(p=>[p.id,p.defaultValue]))};
}
const names=['minimax-h3-multi-reference','minimax-h3-selflift','minimax-h3-sharp'];
for(const name of names)test(`${name}: global selection, Qwen bypass and final Gemini mapping`,async()=>{
 const {workflow,parameters}=load(name);parameters.prompt='source';
 const qwen=workflow.profile.parameters.find(p=>p.key==='328.value');
 assert.equal(selectOptimization(workflow,parameters,false,true,'gemini-test'),undefined);
 if(qwen)assert.equal(parameters[qwen.id],false);
 if(qwen){assert.deepEqual(selectOptimization(workflow,parameters,true,false,'gemini-test'),{model:'gemini-test'});assert.equal(parameters[qwen.id],false);}
 else assert.deepEqual(selectOptimization(workflow,parameters,true,false,'gemini-test'),{model:'gemini-test'});
 const config=selectOptimization(workflow,parameters,true,true,'gemini-test');assert.equal(config?.model,'gemini-test');
 if(qwen)assert.equal(parameters[qwen.id],false);
 const context=sharpInputs(workflow,{workflowId:workflow.id,parameters});
 const result=await optimizeH3(workflow,{workflowId:workflow.id,parameters},{generate:async()=>({text:'FINAL',keyId:'mock',model:'gemini-test'})},async()=>{throw Error('unexpected image');});
 const entries=buildNodeInfoList(workflow.profile,{...parameters,[result.parameterId]:result.text});
 const p=workflow.profile.parameters.find(p=>p.id===context.promptId)!;
 assert.equal(entries.find(e=>e.nodeId===p.nodeId&&e.fieldName===p.fieldName)?.fieldValue,'FINAL');
 if(qwen)assert.equal(entries.find(e=>e.nodeId==='328'&&e.fieldName==='value')?.fieldValue,false);
});

test('all H3 workflow pairs preserve common values and keep sampler settings separate',()=>{
 for(const a of names)for(const b of names){
   const old=load(a).view,next=load(b).view;const draft=createDraft(old);
   draft.parameterValues.duration=12;draft.parameterValues.prompt='keep';draft.instanceType='plus';draft.promptOptimizationEnabled=true;
   const result=transferDraft(draft,old,next,'h3-multi-reference');
   assert.equal(result.parameterValues.duration,12);assert.equal(result.parameterValues.prompt,'keep');
   assert.equal(result.instanceType,'plus');assert.equal(taskOptimizationEnabled(result),true);
   assert.equal(result.commonInputs?.duration,12);
 }
 const a=load(names[2]!).view,b=load(names[0]!).view;const draft=createDraft(a);draft.parameterValues.duration=10.5;
 assert.throws(()=>transferDraft(draft,a,b,'h3-multi-reference'),/时长/);assert.equal(draft.parameterValues.duration,10.5);
 draft.parameterValues.duration=12;draft.parameterValues['193_lowres_scale']=0.7;
 const returned=transferDraft(transferDraft(draft,a,b,'h3-multi-reference'),b,a,'h3-multi-reference');
 assert.equal(returned.parameterValues['193_lowres_scale'],0.7);
});
