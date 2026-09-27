import type { CreateJobDraft, WorkflowView } from "./types.js";
import { isSavedDraft, restoreDraft } from "./draft-storage.js";
import { isMvSuccessor } from "./mv-workflow-identity.js";
import { prepareDraft } from "./task-draft.js";
import { prepareMvBatch } from "./mv-draft.js";
import { createModeForWorkflow } from "./workflow-view.js";

export type CreateBatchItem = { id: string; draft: CreateJobDraft; sourceId?: string };
export function mergeSavedBatches(current: unknown, legacy: unknown): CreateBatchItem[] {
  const result: CreateBatchItem[] = [];
  for (const list of [current, legacy]) if (Array.isArray(list)) for (const item of list) {
    if (item && typeof item.id === "string" && isSavedDraft(item.draft) && !result.some(entry => entry.id === item.id)) result.push(item);
  }
  return result;
}
/** Validate every task against its own workflow, never the currently visible editor. */
export function prepareProductionBatch(items: CreateBatchItem[], workflows: WorkflowView[]): CreateJobDraft[] {
  if (!items.length) throw new Error("没有待提交的任务");
  let legacyMvIndex = 0;
  return items.map((item, index) => {
    try {
      const workflow = workflows.find(w => w.id === item.draft.workflowId);
      if (!workflow) throw new Error("工作流已删除，请重新选择工作流。");
      const mode = createModeForWorkflow(workflow);
      if (mode === "h3-mv") {
        // Only the audited ID replacement may be migrated automatically. The
        // original queued snapshot stays intact until successful submission.
        const input = isMvSuccessor(item.draft.workflowSnapshot?.runningHubWorkflowId, workflow.runningHubWorkflowId)
          ? restoreDraft(item.draft, [workflow], workflow, () => {}) : item.draft;
        const draft = prepareMvBatch([input], workflow)[0]!;
        // Older pending MV snapshots have no sequence metadata. Freeze their
        // current queue order at submission; never derive it from finish time.
        return { ...draft, production: draft.production ?? { groupId: "legacy-mv", segmentIndex: ++legacyMvIndex } };
      }
      return prepareDraft(item.draft, workflow, mode);
    } catch (error) { throw new Error(`第 ${index + 1} 项校验失败，尚未提交：${error instanceof Error ? error.message : "输入不完整"}`); }
  });
}
