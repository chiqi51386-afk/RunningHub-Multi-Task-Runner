import {test} from 'node:test';
import assert from 'node:assert/strict';
import {optimizationInputSignature} from '../frontend/src/optimization-input.js';
import {createDraft,cloneDraft} from '../frontend/src/task-draft.js';
import type {WorkflowView} from '../frontend/src/types.js';
const workflow={id:'sharp',profileVersion:1,parameters:[
 {id:'prompt',key:'247.text',valueType:'string',defaultValue:'hello'},
 {id:'duration',key:'132.value',valueType:'number',defaultValue:10},
 {id:'ratio',key:'115.aspect_ratio',valueType:'string',defaultValue:'9:16'},
 {id:'image',key:'150.image',valueType:'image',referenceIndex:0,defaultValue:''},
]} as WorkflowView;
test('optimization accepts equivalent cloned drafts and unrelated changes',()=>{
 const draft=createDraft(workflow),copy=cloneDraft(draft);
 copy.instanceType='plus';copy.parameterValues.seed=999;copy.mediaOverrides.image!.previewUrl='changed-preview';
 assert.equal(optimizationInputSignature(draft,workflow),optimizationInputSignature(copy,workflow));
});
test('optimization detects every consumed input and workflow version change',()=>{
 const draft=createDraft(workflow),before=optimizationInputSignature(draft,workflow);
 const mutations=[(d:typeof draft)=>{d.parameterValues.prompt='new';},(d:typeof draft)=>{d.parameterValues.duration=20;},(d:typeof draft)=>{d.parameterValues.ratio='16:9';},(d:typeof draft)=>{d.mediaOverrides.image={mode:'replace',enabled:true,localPath:'new.png'};},(d:typeof draft)=>{d.workflowId='other';},(d:typeof draft)=>{d.profileVersion=2;}];
 for(const mutate of mutations){const copy=cloneDraft(draft);mutate(copy);assert.notEqual(optimizationInputSignature(copy,workflow),before);}
});
