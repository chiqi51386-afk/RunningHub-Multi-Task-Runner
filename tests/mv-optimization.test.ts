import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parsePortableWorkflowPackage,materializePortableProfile} from '../src/core/workflows/package.js';
import {optimizeH3} from '../src/core/gemini/h3Optimizer.js';
import {applyMvShared,newMvDraft} from '../frontend/src/mv-draft.js';
import {generateGemini} from '../src/core/gemini/client.js';
import type {WorkflowRecord} from '../src/core/types.js';
import type {WorkflowView} from '../frontend/src/types.js';
test('MV segment selection survives shared settings and single-stage optimization receives segment/audio context',async()=>{
 const pkg=parsePortableWorkflowPackage(JSON.parse(readFileSync('bundled-workflows/h3-digital-human-mv.rhworkflow.json','utf8')));
 const profile=materializePortableProfile(pkg,'mv',1);
 const w:WorkflowRecord={id:'mv',name:'mv',raw:pkg.workflow.apiJson,runningHubWorkflowId:pkg.workflow.runningHubWorkflowId,profile,profileVersion:1,workflowHash:pkg.workflow.workflowHash,createdAt:0,updatedAt:0};
 const view={...w,parameters:profile.parameters} as unknown as WorkflowView;
 const shared=newMvDraft(view);shared.promptOptimizationEnabled=true;
 const audio=profile.parameters.find(p=>p.key==='34.audio')!;
 shared.mediaOverrides[audio.id]={enabled:true,mode:'replace',localPath:'song.mp3'};
 const source=newMvDraft(view,60);source.promptOptimizationEnabled=true;
 const draft=applyMvShared(source,shared,view);
 shared.promptOptimizationEnabled=false;assert.equal(draft.promptOptimizationEnabled,true);
 source.promptOptimizationEnabled=false;shared.promptOptimizationEnabled=true;
 assert.equal(applyMvShared(source,shared,view).promptOptimizationEnabled,false);
 const prompt=profile.parameters.find(p=>p.key==='87.value')!;draft.parameterValues[prompt.id]='sing';
 profile.promptOptimization={model:'test',raw:w.raw,firstStage:{id:'test',name:'test',hash:'test',content:'Rewrite without changing source audio.'}} as any;
 let count=0;
 const result=await optimizeH3(w,{workflowId:'mv',parameters:draft.parameterValues,media:[{parameterId:audio.id,localPath:'song.mp3'}]},{generate:async input=>{
  count++;const task=JSON.parse(input.text);assert.equal(task.mode,'Ref2VA');assert.deepEqual(task.availableAudio,['<Audio 1>']);
  assert.deepEqual(task.audioSegment,{startSeconds:60,endSeconds:70,durationSeconds:10,outputTimelineStartsAt:0});assert.equal(input.audio?.data,'YWJj');
  return {text:count===1?'director':'final',model:'test',keyId:'test'};
 }},async()=>{throw Error('no images');},undefined,'test',undefined,async()=>({mimeType:'audio/mpeg',data:'YWJj'}));
 assert.equal(count,1);assert.equal(result.parameterId,prompt.id);assert.equal(result.text,'director');
});
test('Gemini REST attaches audio rather than claiming nonexistent attachment',async()=>{
 await generateGemini('test','test',{text:'segment',audio:{mimeType:'audio/mpeg',data:'YWJj'}},{fetch:async(_url,options)=>{
  const body=JSON.parse(String(options?.body));assert.ok(body.input.some((p:any)=>p.type==='audio'&&p.data==='YWJj'));
  return Response.json({status:'completed',steps:[{type:'model_output',content:[{type:'text',text:'OK'}]}]});
 }});
});
