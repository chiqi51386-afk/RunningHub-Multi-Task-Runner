import type { CreateJobDraft } from "./types.js";
import { isMvSuccessor } from "./mv-workflow-identity.js";
import type { WorkflowView } from "./types.js";
import { taskOptimizationEnabled, createDraft, compatibleValue, isMediaParameter, setDraftMedia } from "./task-draft.js";

/** Archive before resetting: old ephemeral IDs are not proof of node identity. */
export function restoreDraft(saved: unknown, workflows: WorkflowView[], fallback: WorkflowView | undefined, archive: (draft: CreateJobDraft) => void): CreateJobDraft {
  if (!isSavedDraft(saved)) return createDraft(fallback);
  if (!workflows.length) return saved;
  const snapshot = saved.workflowSnapshot;
  const candidates = snapshot?.runningHubWorkflowId ? workflows.filter(item => item.runningHubWorkflowId === snapshot.runningHubWorkflowId) : [];
  const matching = workflows.find(item => item.id === saved.workflowId) ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (matching?.id === saved.workflowId && matching.profileVersion === saved.profileVersion) return saved;
  archive(saved);
  let restored = createDraft(matching ?? fallback);
  if (!matching || !snapshot || !Array.isArray(snapshot.parameters) || (snapshot.runningHubWorkflowId !== matching.runningHubWorkflowId && !isMvSuccessor(snapshot.runningHubWorkflowId, matching.runningHubWorkflowId))) return restored;
  restored.instanceType = saved.instanceType;
  restored.taskName = saved.taskName;
  restored.promptOptimizationEnabled = taskOptimizationEnabled(saved);
  restored.commonInputs = saved.commonInputs ? {...saved.commonInputs}:undefined;
  if (saved.production) restored.production = { ...saved.production };
  for (const target of matching.parameters) {
    // An integer-to-float schema correction must not discard the user's duration.
    const sources = snapshot.parameters.filter(item => item.key === target.key &&
      (item.valueType === target.valueType || (item.valueType === "integer" && target.valueType === "number")) && item.semanticType === target.semanticType);
    if (sources.length !== 1 || matching.parameters.filter(item => item.key === target.key).length !== 1 || target.mappingIssue) continue;
    const source = sources[0]!;
    if (isMediaParameter(target)) {
      const media = saved.mediaOverrides[source.id];
      if (media) restored = setDraftMedia(restored, target, { ...media });
    } else if (target.visible !== false && compatibleValue(target, saved.parameterValues[source.id])) {
      restored.parameterValues[target.id] = saved.parameterValues[source.id];
    }
  }
  return restored;
}

export function serializeDraft(value: unknown): string {
  return JSON.stringify(value, (key, item) => key === "file" || (key === "previewUrl" && typeof item === "string" && /^(blob:|data:)/.test(item)) ? undefined : item);
}

export function isSavedDraft(value: unknown): value is CreateJobDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as CreateJobDraft;
  return typeof draft.workflowId === "string" && Number.isInteger(draft.profileVersion) &&
    !!draft.parameterValues && typeof draft.parameterValues === "object" && !Array.isArray(draft.parameterValues) &&
    !!draft.mediaOverrides && typeof draft.mediaOverrides === "object" && !Array.isArray(draft.mediaOverrides) &&
    Object.values(draft.mediaOverrides).every(media => media && ["replace", "clear"].includes(media.mode));
}

export function readSaved(key: string): unknown {
  try { return JSON.parse(localStorage.getItem(key) ?? "null"); } catch { return null; }
}
