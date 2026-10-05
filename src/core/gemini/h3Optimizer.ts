import type { WorkflowRecord, CreateJobInput } from '../types.js';
import type { GeminiPool } from './pool.js';
import type { GeminiGenerateInput } from './types.js';
import { H3_SKILL, H3_REFERENCE_GUIDE, H3_BASE_GUIDE } from './h3OfficialSkill.js';

import { H3_OPTIMIZATION_ROUTES } from './routes.js';
export const SHARP_WORKFLOW_ID='2106577322987307010';
export const SHARP_IMAGE_NODES=['150','222','223','240','241','242','243','244','245'];
export function sharpInputs(workflow:WorkflowRecord,input:CreateJobInput) {
  const route=H3_OPTIMIZATION_ROUTES[workflow.runningHubWorkflowId];
  if(!route)throw new Error('该工作流未接入 Gemini 优化。');
  const nodes=workflow.raw as Record<string,{inputs:Record<string,unknown>}>;
  const promptNode=route.prompt.split('.')[0]!;
  const matches=(value:unknown,node:string)=>JSON.stringify(value)===JSON.stringify([node,0]);
  if(!matches(nodes[route.consumer]?.inputs.prompt,route.qwen?'327':promptNode))throw new Error('生成词连接已变化，停止优化。');
  if(route.qwen && (!matches(nodes['327']?.inputs.boolean,'328') || !matches(nodes['327']?.inputs.on_false,promptNode) || !matches(nodes['327']?.inputs.on_true,'323') || !matches(nodes['323']?.inputs.prompt,promptNode)))throw new Error('千问旁路连接已变化，停止优化。');
  if(route.qwen){const toggle=workflow.profile.parameters.find(p=>p.key==='328.value');if(!toggle || input.parameters[toggle.id]!==false)throw new Error('Gemini 优化必须关闭千问分支。');}
  const prompt=workflow.profile.parameters.find(p=>p.key===route.prompt);
  const duration=workflow.profile.parameters.find(p=>p.key===route.duration);
  const ratio=workflow.profile.parameters.find(p=>p.key===route.ratio);
  if(!prompt||prompt.semanticType!=='prompt'||!duration||!ratio)throw new Error('生成参数映射不完整。');
  const text=input.parameters[prompt.id];
  const seconds=input.parameters[duration.id];
  if(typeof text!=='string'||!text.trim())throw new Error('请先填写生成词。');
  if(typeof seconds!=='number'||!Number.isFinite(seconds)||seconds<=0)throw new Error('视频时长无效。');
  const images=route.images.map((id,index)=>{
    const field=route.keyframes ? (index===0?'first_frame':'last_frame') : `ref_images.ref_image_${index}`;
    if(JSON.stringify(nodes[route.consumer]?.inputs[field])!==JSON.stringify([id,0]))throw new Error('图片连接已变化，停止优化。');
    const p=workflow.profile.parameters.find(p=>p.key===`${id}.image`);
    if(!p||p.referenceIndex!==index||p.mappingIssue)throw new Error(`图片 ${index+1} 映射不一致。`);
    const media=input.media?.find(m=>m.parameterId===p.id);
    return media?{referenceIndex:index+1,localPath:media.localPath}:undefined;
  }).filter((v):v is {referenceIndex:number;localPath:string}=>!!v);
  let audio: {localPath:string;startSeconds:number;durationSeconds:number}|undefined;
  if(route.audio && route.start){
    const source=workflow.profile.parameters.find(p=>p.key===route.audio);
    const start=workflow.profile.parameters.find(p=>p.key===route.start);
    const file=input.media?.find(m=>m.parameterId===source?.id);
    const offset=start?input.parameters[start.id]:undefined;
    if(!file || typeof offset!=='number'||!Number.isFinite(offset)||offset<0)throw new Error('数字人音频或起点无效。');
    if(!matches(nodes['85']?.inputs.audio,'34')||!matches(nodes['38']?.inputs.audio,'85')||!matches(nodes['65']?.inputs.audio,'85'))throw new Error('数字人音频链路已变化，停止优化。');
    audio={localPath:file.localPath,startSeconds:offset,durationSeconds:seconds};
  }
  return {promptId:prompt.id,text,seconds,ratio:input.parameters[ratio.id],images,keyframes:!!route.keyframes,audio};
}

export async function optimizeH3(workflow:WorkflowRecord,input:CreateJobInput,pool:Pick<GeminiPool,'generate'>,readImage:(path:string)=>Promise<{mimeType:'image/jpeg'|'image/png'|'image/webp';data:string}>, signal?:AbortSignal, model?:string, checkpoint?:(state:NonNullable<WorkflowRecord["profile"]["promptOptimization"]>)=>Promise<void>,readAudio?:(path:string)=>Promise<NonNullable<GeminiGenerateInput['audio']>>) {
  const context=sharpInputs(workflow,input);
  if(context.audio&&!readAudio)throw new Error('数字人音频读取未配置，未提交视频任务。');
  const audio=context.audio?await readAudio!(context.audio.localPath):undefined;
  const images:NonNullable<GeminiGenerateInput['images']>=[];
  for(const image of context.images)images.push({referenceIndex:context.keyframes?images.length+1:image.referenceIndex,...await readImage(image.localPath)});
  const mode=context.keyframes ? (images.length===2?'FL2VA':images.length===1?(context.images[0]!.referenceIndex===1?'I2VA':'L2VA'):'T2VA') : images.length||audio?'Ref2VA':'T2VA';
  const referenceMode=mode==='Ref2VA';
  const saved=workflow.profile.promptOptimization;
  let sourceText=context.text;
  const taskContext={mode,durationSeconds:context.seconds,aspectRatio:context.ratio,availablePictures:images.map(i=>`<Picture ${i.referenceIndex}>`),keyframeRoles:context.keyframes?context.images.map((image,index)=>({picture:index+1,role:image.referenceIndex===1?'first_frame':'last_frame'})):undefined,availableAudio:audio?["<Audio 1>"]:[],audioSegment:context.audio?{startSeconds:context.audio.startSeconds,endSeconds:context.audio.startSeconds+context.seconds,durationSeconds:context.seconds,outputTimelineStartsAt:0}:undefined,availableVideo:[]};
  saved && (saved.originalText ??= context.text);
  const systemInstruction=[
    saved?.skill?.content ?? `# Selected H3 Skill: h3-prompt-writing\n\n${H3_SKILL}\n\n# Required H3 reference: ${referenceMode?'ref-en.txt':'base-en.txt'}\n\n${referenceMode?H3_REFERENCE_GUIDE:H3_BASE_GUIDE}`,
    `# Application context\nThe selected workflow mode is ${mode}; target duration is ${context.seconds} seconds. Rewrite the user's request into the final H3 generation prompt using the selected Skill. Return the prompt only. Picture labels identify actual workflow slots, not a compacted list: preserve each supplied label even when numbers have gaps. ${context.keyframes ? "Use keyframeRoles to anchor the supplied first/last frame on the timeline; these are not general reference pictures." : "Each attached picture is a general visual reference, not an implicit first or last frame."} Only the listed assets are supplied; examples in the Skill are not task assets. Preserve the user's story and dialogue.`,
    ...(audio ? ['The attached file is the full source audio, NOT a pre-trimmed clip. Only analyze audioSegment.startSeconds through endSeconds. The workflow trims exactly that segment and reuses it as the output soundtrack and fixed audio latent. Describe visible performance synchronized with that segment, with output time starting at zero. Preserve the supplied speech/lyrics; do not invent dialogue, substitute voices, or add music/sound effects. Do not describe content from outside the specified segment.'] : []),
  ].join('\n\n');
  signal?.throwIfAborted();
  if(saved)await checkpoint?.(saved);
  const result=await pool.generate({systemInstruction,images,audio,text:JSON.stringify({...taskContext,userRequest:sourceText}),maxOutputTokens:8192},signal,model).catch(error=>{throw new Error(`生成词优化失败：${error instanceof Error?error.message:String(error)}`);});
  // Check transport completeness in the client, not the model's prose or reference syntax.
  if(!result.text.trim())throw new Error('生成词优化未返回文本，未提交视频任务。');
  signal?.throwIfAborted();
  if(saved){saved.finalText=result.text;await checkpoint?.(saved);}
  return {text:result.text,parameterId:context.promptId,model:result.model};
}
