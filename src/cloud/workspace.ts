import { randomUUID } from "node:crypto";
import { createDraft, prepareDraft, setDraftMedia, taskOptimizationEnabled, compatibleValue, type CreateMode } from "../core/drafts/task-draft.js";
import { applyMvShared, prepareMvBatch, mvParameter } from "../core/drafts/mv-draft.js";
import type { WorkflowView } from "../core/drafts/types.js";
import type { CreateJobInput } from "../core/types.js";
import type { CloudRuntime } from "./runtime.js";

export const MODULES = {
  "h3-multi-reference": "2106577322987307010",
  "h3-first-last": "2106994828660080641",
  "h3-mv": "2107063778012905474",
  "digital-human": "infinitetalk",
} as const;
export interface TaskForm {
  module: keyof typeof MODULES;
  taskName?: string; prompt?: string; negativePrompt?: string; optimize?: boolean;
  images?: string[]; firstFrame?: string; lastFrame?: string; audio?: string;
  durationSeconds?: number; aspectRatio?: string; resolution?: number;
  plus?: boolean; highresTiling?: boolean;
  segments?: Array<{prompt?: string; optimize?: boolean; images?: string[]; startSeconds?: number; endSeconds?: number}>;
}
const fields = new Set(["module","taskName","prompt","negativePrompt","optimize","images","firstFrame","lastFrame","audio","durationSeconds","aspectRatio","resolution","plus","highresTiling","segments"]);
export async function prepareTaskForm(runtime: CloudRuntime, form: TaskForm): Promise<CreateJobInput[]> {
  if (!form || typeof form !== "object" || !(form.module in MODULES)) throw new Error("请选择有效模块");
  for (const key of Object.keys(form)) if (!fields.has(key)) throw new Error(`未知操作字段：${key}`);
  for (const key of ["optimize","plus","highresTiling"] as const) if (form[key] !== undefined && typeof form[key] !== "boolean") throw new Error(`${key} 必须是开关`);
  const workflow = runtime.backend.workflows.list().find(w => form.module === "digital-human" ? w.id === "builtin:infinitetalk-digital-human.rhworkflow.json" : w.runningHubWorkflowId === MODULES[form.module]);
  if (!workflow) throw new Error("模块工作流未安装");
  const view: WorkflowView = { ...workflow, parameters: workflow.profile.parameters, parameterCount: workflow.profile.parameters.length, needsReview:false };
  const mode = form.module as CreateMode;
  const base = createDraft(view); base.taskName = form.taskName;
  if (form.optimize !== undefined) base.promptOptimizationEnabled = form.optimize;
  if (form.plus !== undefined) base.instanceType = form.plus ? "plus" : "default";
  const set = (semantic: string, value: unknown) => {
    if (value === undefined) return;
    const targets = view.parameters.filter(p => p.visible !== false && p.semanticType === semantic);
    if (targets.length !== 1) throw new Error(`当前模块不支持该操作：${semantic}`);
    base.parameterValues[targets[0]!.id] = value;
  };
  set("prompt",form.prompt); set("negative_prompt",form.negativePrompt); set("aspect_ratio",form.aspectRatio);
  if (form.resolution !== undefined) {
    const p = view.parameters.find(p => p.classType === "ResolutionSelector" && p.fieldName === "megapixels");
    if (!p) throw new Error("当前模块没有分辨率设置"); base.parameterValues[p.id] = form.resolution;
  }
  if (form.highresTiling !== undefined) {
    const p=view.parameters.find(p=>p.fieldName==="highres_tiling"); if(!p)throw new Error("当前模块没有分块设置");base.parameterValues[p.id]=form.highresTiling;
  }
  if(form.durationSeconds!==undefined){if(mode==="h3-mv")throw new Error("H3 数字人使用起止时间或完整音频");set("duration",form.durationSeconds);}
  const slots = view.parameters.filter(p=>p.visible!==false&&p.valueType==="image").sort((a,b)=>(a.referenceIndex??a.displayOrder??9999)-(b.referenceIndex??b.displayOrder??9999));
  if(mode!=="h3-first-last"&&(form.firstFrame||form.lastFrame))throw new Error("首尾帧只适用于首尾帧模块");
  if(mode==="h3-first-last"&&form.images!==undefined)throw new Error("首尾帧请使用 firstFrame / lastFrame");
  const putImages = async (draft: typeof base, images: (string|undefined)[]) => {
    if(!Array.isArray(images)||images.length>slots.length)throw new Error("图片数量超出模块上限");
    let result=draft;
    for(let i=0;i<slots.length;i++) result=setDraftMedia(result,slots[i]!,images[i]?{enabled:true,mode:"replace",localPath:await runtime.mediaPath(images[i]!)}:{enabled:false,mode:"clear"});
    return result;
  };
  let shared=await putImages(base,mode==="h3-first-last"?[form.firstFrame,form.lastFrame]:form.images??[]);
  if(form.audio){const p=view.parameters.find(p=>p.visible!==false&&p.valueType==="audio");if(!p)throw new Error("当前模块不支持音频");shared=setDraftMedia(shared,p,{enabled:true,mode:"replace",localPath:await runtime.mediaPath(form.audio)});}
  if(mode!=="h3-mv"&&form.segments!==undefined)throw new Error("当前模块不支持分段");
  const segments=mode==="h3-mv"?(form.segments??[{}]):[{}];
  if(!Array.isArray(segments)||!segments.length||segments.length>100)throw new Error("段落数量须在 1–100 之间");
  const groupId=randomUUID();const result:CreateJobInput[]=[];let previousEnd=0;let previousOptimize=taskOptimizationEnabled(shared);
  for(let i=0;i<segments.length;i++){
    const segment=segments[i]!;
    if(!segment||typeof segment!=="object"||Object.keys(segment).some(k=>!["prompt","optimize","images","startSeconds","endSeconds"].includes(k)))throw new Error("无效的段落设置");
    if(segment.optimize!==undefined&&typeof segment.optimize!=="boolean")throw new Error("段落 optimize 必须是开关");
    let draft=structuredClone(shared);
    if(segment.images!==undefined)draft=await putImages(draft,segment.images);
    if(segment.prompt!==undefined){const p=view.parameters.find(p=>p.visible!==false&&p.semanticType==="prompt")!;draft.parameterValues[p.id]=segment.prompt;}
    draft.promptOptimizationEnabled=segment.optimize??previousOptimize;previousOptimize=draft.promptOptimizationEnabled;
    draft=mode==="h3-mv"?applyMvShared(draft,shared,view):draft;
    draft=prepareDraft(draft,view,mode);
    for(const p of view.parameters.filter(p=>p.visible!==false&&!["image","audio","video"].includes(p.valueType))) {
      if(!compatibleValue(p,draft.parameterValues[p.id]))throw new Error(`参数不符合工作流设置：${p.label??p.id}`);
      if(p.semanticType==="prompt"&&!String(draft.parameterValues[p.id]??"").trim())throw new Error("请填写生成词");
    }
    if(mode==="digital-human"&&!form.audio)throw new Error("请添加音频");
    const parameters={...draft.parameterValues};
    if(mode==="h3-mv"){delete parameters[mvParameter(view,"85.start_index").id];delete parameters[mvParameter(view,"85.duration").id];}
    const media=Object.entries(draft.mediaOverrides).filter(([,m])=>m.mode==="replace").map(([parameterId,m])=>({parameterId,localPath:m.localPath!}));
    if(!media.some(m=>slots.some(p=>p.id===m.parameterId)))throw new Error("请添加人物或参考图片");
    if(mode==="h3-mv"&&i<segments.length-1&&segment.endSeconds===undefined)throw new Error("非最后一段必须指定结束时间");
    const input=await runtime.prepare({workflowId:workflow.id,taskName:form.taskName,parameters,media,optimize:taskOptimizationEnabled(draft),instanceType:form.plus===undefined?undefined:draft.instanceType,
      ...(mode==="h3-mv"?{audioRange:{startSeconds:segment.startSeconds??previousEnd,...(segment.endSeconds===undefined?{}:{endSeconds:segment.endSeconds})},production:{groupId,segmentIndex:i+1}}:{})});
    if(mode==="h3-mv"){
      draft.parameterValues=input.parameters;prepareMvBatch([draft],view);
      previousEnd=Number(input.parameters[mvParameter(view,"85.start_index").id])+Number(input.parameters[mvParameter(view,"85.duration").id]);
    }
    result.push(input);
  }
  return result;
}
