import type { CreateJobDraft, WorkflowView } from "./types.js";
import { cloneDraft, createDraft, prepareDraft, setDraftMedia } from "./task-draft.js";

export function mvParameter(workflow: WorkflowView, key: string) {
  const parameter = workflow.parameters.find(item => item.key === key);
  if (!parameter) throw new Error(`MV 节点映射缺失：${key}`);
  return parameter;
}

export function newMvDraft(workflow: WorkflowView, start = 0): CreateJobDraft {
  const draft = createDraft(workflow);
  draft.parameterValues[mvParameter(workflow, "85.start_index").id] = start;
  return draft;
}

/** Freeze global controls when adding a segment to the production batch. */
export function applyMvShared(draft: CreateJobDraft, shared: CreateJobDraft, workflow: WorkflowView): CreateJobDraft {
  let result = cloneDraft(draft);
  for (const key of ["61.aspect_ratio", "61.megapixels"]) {
    const p = mvParameter(workflow, key);
    result.parameterValues[p.id] = shared.parameterValues[p.id];
  }
  result.instanceType = shared.instanceType === "plus" ? "plus" : "default";
  const audio = mvParameter(workflow, "34.audio");
  result = setDraftMedia(result, audio, { ...(shared.mediaOverrides[audio.id] ?? { enabled: false, mode: "clear" }) });
  return result;
}

export function prepareMvBatch(drafts: CreateJobDraft[], workflow: WorkflowView) {
  if (!drafts.length) throw new Error("没有待提交的段落");
  return drafts.map((draft, index) => {
    const prepared = prepareDraft(draft, workflow, "h3-mv");
    const value = (key: string) => prepared.parameterValues[mvParameter(workflow, key).id];
    const audio = prepared.mediaOverrides[mvParameter(workflow, "34.audio").id];
    if (typeof value("87.value") !== "string" || !String(value("87.value")).trim()) throw new Error(`第 ${index + 1} 段未填写生成词`);
    if (audio?.mode !== "replace" || (!audio.localPath && !audio.file)) throw new Error(`第 ${index + 1} 段未选择音频`);
    const start = value("85.start_index"), duration = value("85.duration");
    if (typeof start !== "number" || !Number.isFinite(start) || start < 0) throw new Error(`第 ${index + 1} 段音频起点无效`);
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) throw new Error(`第 ${index + 1} 段时长必须大于 0 秒（结束时间须大于起点）`);
    for (const key of ["61.aspect_ratio", "61.megapixels"]) {
      const p = mvParameter(workflow, key), v = prepared.parameterValues[p.id];
      if (key.endsWith("megapixels") && (typeof v !== "number" || !Number.isFinite(v) || v <= 0)) throw new Error("分辨率无效");
      if (p.options?.length && !p.options.some(option => JSON.stringify(option) === JSON.stringify(v))) throw new Error("画面比例无效");
    }
    return prepared;
  });
}
