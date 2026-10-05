import type { CreateJobDraft, MediaParameterDraft, WorkflowParameterView, WorkflowView } from "./types.js";
import type { TtsAudio } from "../../src/core/gemini/ttsTypes.js";

export type CreateMode = "digital-human" | "h3-multi-reference" | "h3-first-last" | "h3-mv" | "personal";
export const isMediaParameter = (parameter: WorkflowParameterView) => ["image", "video", "audio"].includes(parameter.valueType);
export function taskOptimizationEnabled(draft:CreateJobDraft):boolean {
  return draft.promptOptimizationEnabled ?? draft.geminiOptimization ?? (draft.parameterValues.chinese_prompt_optimization===true);
}
export function cloneDraft(draft: CreateJobDraft): CreateJobDraft {
  return { ...draft, commonInputs: draft.commonInputs ? {...draft.commonInputs}:undefined, production: draft.production ? { ...draft.production } : undefined, parameterValues: { ...draft.parameterValues }, mediaOverrides: Object.fromEntries(Object.entries(draft.mediaOverrides).map(([id, media]) => [id, { ...media }])) };
}
export function createDraft(workflow?: WorkflowView): CreateJobDraft {
  const parameterValues = Object.fromEntries((workflow?.parameters ?? []).map(parameter => [parameter.id, parameter.defaultValue]));
  const h3Defaults = !!workflow && ["2106577322987307010", "2106994828660080641", "2107063778012905474"].includes(workflow.runningHubWorkflowId ?? "");
  if (h3Defaults) for (const parameter of workflow!.parameters) {
    if (parameter.classType === "ResolutionSelector" && parameter.fieldName === "megapixels") parameterValues[parameter.id] = 1.5;
    if (parameter.fieldName === "highres_tiling") parameterValues[parameter.id] = true;
  }
  const mediaOverrides: Record<string, MediaParameterDraft> = {};
  for (const parameter of workflow?.parameters ?? []) {
    if (!isMediaParameter(parameter)) continue;
    mediaOverrides[parameter.id] = { enabled: false, mode: "clear" };
    if (parameter.mediaControl?.autoEnableOnReplace) parameterValues[parameter.mediaControl.parameterId] = parameter.mediaControl.inactiveValue;
  }
  return { workflowSnapshot: workflow ? structuredClone(workflow) : undefined, workflowId: workflow?.id ?? "", profileVersion: workflow?.profileVersion ?? 0, instanceType: "default", promptOptimizationEnabled: h3Defaults, parameterValues, mediaOverrides };
}
export function visibleMedia(workflow: WorkflowView | undefined, mode: CreateMode) {
  const media = (workflow?.parameters ?? []).filter(parameter => parameter.visible !== false && isMediaParameter(parameter))
    .sort((a, b) => (a.referenceIndex ?? a.displayOrder ?? 9999) - (b.referenceIndex ?? b.displayOrder ?? 9999));
  if (mode === "h3-multi-reference") return media.filter(parameter => parameter.valueType === "image").slice(0, workflow?.runningHubWorkflowId === "2106577322987307010" ? 9 : 6);
  if (mode === "personal") return media;
  return media.filter(parameter => parameter.valueType === "image" || parameter.valueType === "audio")
    .sort((a, b) => Number(a.valueType === "audio") - Number(b.valueType === "audio"));
}
export function setDraftMedia(draft: CreateJobDraft, parameter: WorkflowParameterView, media: MediaParameterDraft): CreateJobDraft {
  const parameterValues = { ...draft.parameterValues };
  if (parameter.mediaControl?.autoEnableOnReplace) parameterValues[parameter.mediaControl.parameterId] = media.mode === "replace" ? parameter.mediaControl.activeValue : parameter.mediaControl.inactiveValue;
  return { ...draft, parameterValues, mediaOverrides: { ...draft.mediaOverrides, [parameter.id]: media } };
}
export function applyTtsAudio(draft:CreateJobDraft,workflow:WorkflowView,audio:TtsAudio):CreateJobDraft{
  if(draft.workflowId!==workflow.id || draft.profileVersion!==workflow.profileVersion)throw new Error("数字人工作流已更新，请重新选择工作流。");
  const inputs=workflow.parameters.filter(p=>p.valueType==="audio"&&p.visible!==false);
  if(inputs.length!==1)throw new Error("当前数字人工作流没有唯一的音频输入，无法自动填入。");
  return setDraftMedia(draft,inputs[0]!,{...audio,enabled:true,mode:"replace"});
}
// Presentation only: keep gaps and all underlying overrides for submission.
export function expandedImageSlotCount(media: WorkflowParameterView[], draft: CreateJobDraft): number {
  const images = media.filter(parameter => parameter.valueType === "image");
  let count = 2;
  images.forEach((parameter, index) => {
    if (draft.mediaOverrides[parameter.id]?.mode === "replace") count = Math.max(count, index + 2);
  });
  return Math.min(images.length, count);
}
export function exchangeImages(draft: CreateJobDraft, source: WorkflowParameterView, target: WorkflowParameterView): CreateJobDraft {
  if (source.id === target.id || source.valueType !== "image" || target.valueType !== "image") return draft;
  const from = draft.mediaOverrides[source.id];
  if (from?.mode !== "replace") return draft;
  const to = draft.mediaOverrides[target.id] ?? { enabled: false, mode: "clear" as const };
  return setDraftMedia(setDraftMedia(draft, source, { ...to }), target, { ...from });
}
export function compatibleValue(parameter: WorkflowParameterView, value: unknown): boolean {
  if (parameter.options?.length) return parameter.options.some(option => JSON.stringify(typeof option === "object" && option !== null && "value" in option ? option.value : option) === JSON.stringify(value));
  if (["integer", "number"].includes(parameter.valueType)) return typeof value === "number" && Number.isFinite(value) && (parameter.valueType !== "integer" || Number.isInteger(value)) && (parameter.min === undefined || value >= parameter.min) && (parameter.max === undefined || value <= parameter.max);
  return typeof value === typeof parameter.defaultValue;
}
export function transferDraft(current: CreateJobDraft, previous: WorkflowView | undefined, next: WorkflowView, mode: CreateMode): CreateJobDraft {
  if (!previous || current.workflowId !== previous.id) throw new Error("无法确认原工作流映射，已保留当前输入，未切换。");
  for (const workflow of [previous, next]) {
    const issue = visibleMedia(workflow, mode).find(parameter => parameter.mappingIssue);
    if (issue) throw new Error(issue.mappingIssue);
  }
  let result = createDraft(next);
  // Switching workflows retains the user's explicit compute-tier choice.
  // Fresh drafts still start with the standard tier.
  result.instanceType = current.instanceType;
  result.taskName = current.taskName;
  result.promptOptimizationEnabled = taskOptimizationEnabled(current);
  result.workflowInputs = {...current.workflowInputs,[`${previous.id}:${previous.profileVersion}`]:{...current.parameterValues}};
  const remembered=result.workflowInputs[`${next.id}:${next.profileVersion}`];
  if(remembered)for(const p of next.parameters){
    if(p.visible!==false&&!isMediaParameter(p)&&!["prompt","negative_prompt","duration","aspect_ratio"].includes(p.semanticType)&&p.key!=="328.value"&&compatibleValue(p,remembered[p.id]))result.parameterValues[p.id]=remembered[p.id];
  }
  result.commonInputs = {...current.commonInputs};
  for(const semantic of ["duration","aspect_ratio"] as const){
    const source=previous.parameters.filter(p=>p.visible!==false&&p.semanticType===semantic);
    if(source.length===1)result.commonInputs[semantic]=current.parameterValues[source[0]!.id];
    const targets=next.parameters.filter(p=>p.visible!==false&&p.semanticType===semantic);
    const value=result.commonInputs[semantic];
    if(value!==undefined && targets.length===1){
      if(!compatibleValue(targets[0]!,value))throw new Error(`目标工作流不支持当前${semantic==="duration"?"时长":"画面比例"}，输入未丢弃。`);
      result.parameterValues[targets[0]!.id]=value;
    }
  }
  const oldParameters = previous?.parameters ?? [];
  for (const source of oldParameters.filter(item => item.semanticType === "prompt" && item.visible !== false)) {
    const targets = next.parameters.filter(item => item.visible !== false && item.semanticType === source.semanticType && item.valueType === source.valueType);
    const sources = oldParameters.filter(item => item.visible !== false && item.semanticType === source.semanticType && item.valueType === source.valueType);
    if (targets.length !== 1 || sources.length !== 1) throw new Error("生成词映射缺失或存在多个候选，已保留当前输入，未切换工作流。");
  }
  for (const parameter of next.parameters) {
    // Semantic similarity is not compatibility across different node classes.
    // Never transfer model internals (sampler, scheduler, steps, CFG, etc.).
    const portable = ["prompt"];
    if (parameter.visible === false || !portable.includes(parameter.semanticType)) continue;
    const candidates = oldParameters.filter(item => item.visible !== false && item.semanticType === parameter.semanticType && item.valueType === parameter.valueType);
    const source = candidates.find(item => item.key === parameter.key) ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (source) {
      if (!compatibleValue(parameter, current.parameterValues[source.id])) throw new Error(`目标工作流不支持当前参数 ${parameter.fieldName}，请先调整，输入未丢弃。`);
      result.parameterValues[parameter.id] = current.parameterValues[source.id];
    }
  }
  const oldMedia = visibleMedia(previous, mode);
  for (const type of ["image", "audio"] as const) {
    const sources = oldMedia.filter(item => item.valueType === type);
    const targets = visibleMedia(next, mode).filter(item => item.valueType === type);
    if (sources.slice(targets.length).some(source => current.mediaOverrides[source.id]?.mode === "replace")) throw new Error("目标工作流媒体槽不足，已保留输入，未切换。");
    visibleMedia(next, mode).filter(item => item.valueType === type).forEach((target, index) => {
      const source = target.referenceIndex !== undefined && sources.some(item => item.referenceIndex !== undefined)
        ? sources.find(item => item.referenceIndex === target.referenceIndex) : sources[index];
      if (!source && sources[index] && current.mediaOverrides[sources[index]!.id]?.mode === "replace") throw new Error("参考图编号不兼容，已保留输入，未切换。");
      const media = source ? current.mediaOverrides[source.id] : undefined;
      if (media) result = setDraftMedia(result, target, { ...media });
    });
  }
  return result;
}
export function clearDraftInputs(draft: CreateJobDraft, workflow: WorkflowView): CreateJobDraft {
  let result = cloneDraft(draft);
  result.taskName = undefined;
  for (const parameter of workflow.parameters) {
    if (parameter.semanticType === "prompt" && parameter.visible !== false) result.parameterValues[parameter.id] = "";
    if (isMediaParameter(parameter)) result = setDraftMedia(result, parameter, { enabled: false, mode: "clear" });
  }
  return result;
}
export function prepareDraft(draft: CreateJobDraft, workflow: WorkflowView, mode: CreateMode): CreateJobDraft {
  if (draft.workflowId !== workflow.id || draft.profileVersion !== workflow.profileVersion) throw new Error("工作流映射已变化，请重新确认输入后提交。");
  if (Object.values(draft.mediaOverrides).some(media => media.mode === "replace" && !media.localPath && !media.file)) throw new Error("草稿素材无法恢复，请重新选择文件后提交。");
  const issue = visibleMedia(workflow, mode).find(parameter => parameter.mappingIssue);
  if (issue) throw new Error(issue.mappingIssue);
  let result = cloneDraft(draft);
  for(const semantic of ["duration","aspect_ratio"] as const){
    const value=result.commonInputs?.[semantic];
    const targets=workflow.parameters.filter(p=>p.visible!==false&&p.semanticType===semantic);
    if(value!==undefined&&targets.length===1){if(!compatibleValue(targets[0]!,value))throw new Error("公共参数与当前工作流不兼容");result.parameterValues[targets[0]!.id]=value;}
  }
  const allowed = new Set(visibleMedia(workflow, mode).map(item => item.id));
  for (const parameter of workflow.parameters) {
    if (isMediaParameter(parameter) && !allowed.has(parameter.id)) result = setDraftMedia(result, parameter, { enabled: false, mode: "clear" });
  }
  return result;
}
