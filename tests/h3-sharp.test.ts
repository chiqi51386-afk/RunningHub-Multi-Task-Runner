import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parsePortableWorkflowPackage,materializePortableProfile} from '../src/core/workflows/package.js';
import {resolveMediaInputs} from '../src/core/workflows/mediaInputs.js';
import {optimizeH3,sharpInputs,SHARP_IMAGE_NODES} from '../src/core/gemini/h3Optimizer.js';
import {buildNodeInfoList} from '../src/core/workflows/nodeInfo.js';
import {H3_BASE_GUIDE,H3_REFERENCE_GUIDE} from '../src/core/gemini/h3OfficialSkill.js';
import {createDraft} from '../frontend/src/task-draft.js';
import {restoreDraft} from '../frontend/src/draft-storage.js';
import type {WorkflowView} from '../frontend/src/types.js';
import type {WorkflowRecord} from '../src/core/types.js';
const pkg=parsePortableWorkflowPackage(JSON.parse(readFileSync('bundled-workflows/minimax-h3-sharp.rhworkflow.json','utf8')));
const profile=materializePortableProfile(pkg,'sharp',1);
const workflow:WorkflowRecord={id:'sharp',name:pkg.workflow.name,runningHubWorkflowId:pkg.workflow.runningHubWorkflowId,raw:pkg.workflow.apiJson,workflowHash:pkg.workflow.workflowHash,profileVersion:1,profile,createdAt:0,updatedAt:0};
const parameters=Object.fromEntries(profile.parameters.map(p=>[p.id,p.defaultValue]));
parameters.prompt='User intent';
const valid='subject_definitions: <Subject 1> from <Picture 9>\nsummary: [reference generation] subject moves\nretention_analysis: fully_preserved\ndetailed_description: [Shot 1] subject moves\noverall_soundscape: room tone\nnon_diegetic_music: N/A';
test('sharp workflow has nine ordered images, empty defaults and original sampler controls',()=>{
 const images=profile.parameters.filter(p=>p.valueType==='image').sort((a,b)=>a.referenceIndex!-b.referenceIndex!);
 assert.deepEqual(images.map(p=>p.nodeId),SHARP_IMAGE_NODES);
 assert.ok(images.every(p=>p.defaultValue===''&&p.visible));
 assert.equal(profile.parameters.find(p=>p.semanticType==='prompt')?.key,'247.text');
 assert.deepEqual(profile.outputs.map(p=>p.nodeId),['229']);
 const raw=workflow.raw as any;
 assert.deepEqual(raw['136'].inputs.prompt,['247',0]);
 assert.equal(raw['193'].inputs.highres_tiling,true);
 assert.equal(raw['193'].inputs.lowres_scale,0.5);
 assert.equal(raw['115'].inputs.aspect_ratio,'9:16 (Portrait Widescreen)');
 const resolved=resolveMediaInputs(profile,parameters,{});
 assert.ok(images.every(p=>resolved.parameters[p.id]===''));
});
test('Google Skill receives actual image nine without renumbering and returns exact prompt field',async()=>{
 const image=profile.parameters.find(p=>p.nodeId==='245'&&p.valueType==='image')!;
 const resolved=resolveMediaInputs(profile,parameters,{[image.id]:{mode:'replace',localPath:'nine.png'}});
 const result=await optimizeH3(workflow,{workflowId:'sharp',...resolved},{generate:async input=>{
   assert.ok(input.systemInstruction?.includes('Full-Reference Mode Rewrite Output Format Guide'));
   assert.ok(!input.systemInstruction?.includes(H3_BASE_GUIDE));
   assert.deepEqual(JSON.parse(input.text).availableAudio,[]);
   assert.deepEqual(JSON.parse(input.text).availableVideo,[]);
   assert.deepEqual(input.images?.map(i=>i.referenceIndex),[9]);
   assert.equal(JSON.parse(input.text).durationSeconds,10);
   return {text:valid,keyId:'test',model:'test'};
 }},async file=>{assert.equal(file,'nine.png');return {mimeType:'image/png',data:'YWJj'};});
 assert.equal(result.parameterId,'prompt');assert.equal(result.text,valid);
 assert.equal(resolved.parameters.prompt,'User intent');
});
test('workflow prompt miswiring still fails before optimization',()=>{
 const changed=structuredClone(workflow);(changed.raw['136'] as any).inputs.prompt=['150',0];
 assert.throws(()=>sharpInputs(changed,{workflowId:'sharp',parameters}),/连接/);
});

test('optimization returns model text unchanged without prose validation',async()=>{
 const text='A free-form prompt: <Picture 9> <Audio 1> At 00:20';
 const result=await optimizeH3(workflow,{workflowId:'sharp',parameters},{generate:async input=>{
   assert.ok(input.systemInstruction?.includes(H3_BASE_GUIDE));
   assert.ok(!input.systemInstruction?.includes(H3_REFERENCE_GUIDE));
   return {text,keyId:'test',model:'test'};
 }},async()=>{throw new Error('no images expected');});
 assert.equal(result.text,text);
 await assert.rejects(optimizeH3(workflow,{workflowId:'sharp',parameters},{generate:async()=>({text:' ',keyId:'test',model:'test'})},async()=>{throw new Error('no images');}),/未返回文本/);
});

test('sharp numeric controls and hidden defaults map to exact API fields',()=>{
 const duration=profile.parameters.find(p=>p.key==='132.value')!;
 assert.equal(duration.valueType,'number');assert.equal(duration.step,0.1);
 const visible=profile.parameters.filter(p=>p.visible&&!['image','prompt'].includes(p.semanticType)).map(p=>p.key);
 assert.deepEqual(visible,['115.aspect_ratio','115.megapixels','132.value','193.lowres_scale','193.highres_tiling']);
 for(const seconds of [1,10,10.1,60]){
   const entries=buildNodeInfoList(profile,{...parameters,[duration.id]:seconds});
   assert.equal(entries.find(p=>p.nodeId==='132'&&p.fieldName==='value')?.fieldValue,seconds);
   for(const key of ['145.strength_model','147.extra_steps','193.seed','193.transition_step']){
     const p=profile.parameters.find(p=>p.key===key)!;
     assert.equal(entries.find(v=>v.nodeId===p.nodeId&&v.fieldName===p.fieldName)?.fieldValue ?? (workflow.raw[p.nodeId] as any).inputs[p.fieldName],p.defaultValue);
   }
 }
});

test('sharp draft schema update retains duration, prompt and image slots, resets hidden controls',()=>{
 const next={id:'sharp',name:'sharp',runningHubWorkflowId:workflow.runningHubWorkflowId,profileVersion:2,parameters:profile.parameters} as WorkflowView;
 const old=structuredClone(next);old.profileVersion=1;
 old.parameters.find(p=>p.key==='132.value')!.valueType='integer';
 old.parameters.find(p=>p.key==='193.transition_step')!.visible=true;
 const draft=createDraft(old);
 draft.parameterValues.duration=12;draft.parameterValues.prompt='Keep this';draft.parameterValues['193_transition_step']=3;
 draft.mediaOverrides.image_9={mode:'replace',localPath:'nine.png',enabled:true};
 const restored=restoreDraft(draft,[next],next,()=>{});
 assert.equal(restored.parameterValues.duration,12);assert.equal(restored.parameterValues.prompt,'Keep this');
 assert.equal(restored.mediaOverrides.image_9?.localPath,'nine.png');assert.equal(restored.parameterValues['193_transition_step'],6);
});

test('sharp sparse images and swapped images retain exact Gemini and API slot identity',async()=>{
 for(const slots of [[0,8],[8,0]]){
   const mediaOverrides=Object.fromEntries([0,8].map((slot,i)=>[profile.parameters.find(p=>p.key===`${SHARP_IMAGE_NODES[slot]}.image`)!.id,{mode:'replace' as const,localPath:`source-${slots[i]}.png`}]));
   const resolved=resolveMediaInputs(profile,parameters,mediaOverrides);
   await optimizeH3(workflow,{workflowId:'sharp',...resolved},{generate:async input=>{
     assert.deepEqual(input.images?.map(i=>i.referenceIndex),[1,9]);
     assert.deepEqual(input.images?.map(i=>i.data),slots.map(s=>Buffer.from(`source-${s}.png`).toString('base64')));
     return {text:valid,keyId:'test',model:'test'};
   }},async path=>({mimeType:'image/png',data:Buffer.from(path).toString('base64')}));
   const entries=buildNodeInfoList(profile,resolved.parameters,resolved.media.map(m=>({...m,uploadedValue:m.localPath})));
   SHARP_IMAGE_NODES.forEach((node,i)=>assert.equal(entries.find(e=>e.nodeId===node&&e.fieldName==='image')?.fieldValue,i===0?`source-${slots[0]}.png`:i===8?`source-${slots[1]}.png`:''));
 }
 const raw=workflow.raw as any;
 assert.deepEqual(raw['131'].inputs['values.a'],['132',0]);assert.deepEqual(raw['136'].inputs.length,['131',1]);
 assert.deepEqual(raw['136'].inputs.width,['115',0]);assert.deepEqual(raw['136'].inputs.height,['115',1]);
});
