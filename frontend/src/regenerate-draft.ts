import type { JobInputSnapshotView, WorkflowView, CreateJobDraft } from "./types.js";
import { compatibleValue, createDraft, setDraftMedia } from "./task-draft.js";

/** Local parameter IDs are not stable across profile revisions. Match API targets. */
export function regenerateDraft(input: JobInputSnapshotView, workflow: WorkflowView): CreateJobDraft {
  if (input.workflowId !== workflow.id) throw new Error("原工作流已改变，不能自动恢复输入。");
  let draft = createDraft(workflow);
  draft.taskName = input.taskName;
  draft.instanceType = input.instanceType === "plus" ? "plus" : "default";
  if (input.production) draft.production = { ...input.production };
  const used = new Set<string>();
  const target = (key: string) => {
    const matches = workflow.parameters.filter(parameter => parameter.key === key);
    if (matches.length !== 1 || used.has(key)) throw new Error(`节点 ${key} 缺失或重复，无法安全恢复，请手动核对。`);
    used.add(key);
    return matches[0]!;
  };
  for (const source of input.parameters) {
    if (!workflow.parameters.some(p => p.key === source.key) && ["58.chunks", "58.seq_threshold", "59.head_chunks"].includes(source.key)) continue;
    const parameter = target(source.key);
    if (source.value === undefined) continue;
    if (parameter.visible === false || parameter.semanticType === "negative_prompt") continue;
    if (parameter.semanticType !== source.semanticType || !compatibleValue(parameter, source.value)) {
      throw new Error(`节点 ${source.key} 的参数定义已变化，无法安全恢复，请手动核对。`);
    }
    // Hidden model internals and built-in negative prompts belong to the current workflow.
    draft.parameterValues[parameter.id] = source.value;
  }
  for (const source of input.media) {
    const parameter = target(source.key);
    if (parameter.valueType !== source.type) throw new Error(`节点 ${source.key} 的素材类型已变化。`);
    if (source.mode === "replace" && !source.localPath) throw new Error(`节点 ${source.key} 缺少原素材路径，请重新选择。`);
    if (source.mode === "default") throw new Error(`旧任务节点 ${source.key} 使用了云端默认素材，无法确认原图片或音频，请手动选择。`);
    draft = setDraftMedia(draft, parameter, source.mode === "replace"
      ? { enabled: true, mode: "replace", localPath: source.localPath, fileName: source.fileName, previewUrl: source.previewUrl }
      : { enabled: false, mode: "clear" });
  }
  return draft;
}
