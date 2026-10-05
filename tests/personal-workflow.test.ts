import assert from 'node:assert/strict';
import test from 'node:test';
import { createModeForWorkflow } from '../frontend/src/workflow-view.js';
import { createDraft, prepareDraft, visibleMedia } from '../frontend/src/task-draft.js';
import type { WorkflowView } from '../frontend/src/types.js';

test('personal imports have an independent module even with a built-in remote ID', () => {
  assert.equal(createModeForWorkflow({builtIn:false,runningHubWorkflowId:'2106577322987307010'} as WorkflowView),'personal');
  assert.equal(createModeForWorkflow({builtIn:true,runningHubWorkflowId:'2106577322987307010'} as WorkflowView),'h3-multi-reference');
  assert.equal(createModeForWorkflow({runningHubWorkflowId:'custom-id'} as WorkflowView),'personal');
});
test('personal submissions retain all image, audio, video mappings and arbitrary parameters', () => {
  const workflow = {id:'custom',profileVersion:1,builtIn:false,runningHubWorkflowId:'custom-id',parameters:[
    ...['image','audio','video'].map((valueType,index)=>({id:`media-${index}`,key:`${index}.input`,valueType,semanticType:'unknown',visible:true})),
    {id:'steps',key:'25.steps',valueType:'number',semanticType:'unknown',defaultValue:12,visible:true}
  ]} as WorkflowView;
  const draft=createDraft(workflow);
  for(const parameter of visibleMedia(workflow,'personal')) draft.mediaOverrides[parameter.id]={enabled:true,mode:'replace',localPath:`C:/media/${parameter.id}`};
  draft.parameterValues.steps=24;
  const prepared=prepareDraft(draft,workflow,'personal');
  assert.equal(visibleMedia(workflow,'personal').length,3);
  assert.equal(prepared.parameterValues.steps,24);
  assert.deepEqual(prepared.mediaOverrides,draft.mediaOverrides);
  assert.throws(()=>prepareDraft({...draft,profileVersion:2},workflow,'personal'),/映射已变化/);
});
