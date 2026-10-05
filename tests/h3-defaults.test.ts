import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createDraft} from '../frontend/src/task-draft.js';
import type {WorkflowView} from '../frontend/src/types.js';

test('fresh H3 drafts enable optimization and tiling with 1.5 MP',()=>{
  for(const file of ['minimax-h3-sharp','h3-first-last','h3-digital-human-mv']){
    const pkg=JSON.parse(readFileSync(`bundled-workflows/${file}.rhworkflow.json`,'utf8'));
    const workflow={id:file,profileVersion:1,runningHubWorkflowId:pkg.workflow.runningHubWorkflowId,parameters:pkg.profile.parameters} as WorkflowView;
    const draft=createDraft(workflow);
    assert.equal(draft.promptOptimizationEnabled,true);
    for(const p of workflow.parameters){
      if(p.fieldName==='megapixels')assert.equal(draft.parameterValues[p.id],1.5);
      if(p.fieldName==='highres_tiling')assert.equal(draft.parameterValues[p.id],true);
    }
  }
});
