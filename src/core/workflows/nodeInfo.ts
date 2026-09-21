import type { JobMedia, NodeInfo, WorkflowProfile } from "../types.js";

export function buildNodeInfoList(
  profile: WorkflowProfile,
  jobInputs: Record<string, unknown>,
  media: JobMedia[] = [],
): NodeInfo[] {
  const mediaByParameter = new Map(media.map(item => [item.parameterId, item]));
  const resolvedInputs = { ...jobInputs };
  for (const parameter of profile.parameters) {
    const mediaItem = mediaByParameter.get(parameter.id);
    if (mediaItem?.uploadedValue !== undefined && parameter.mediaControl?.autoEnableOnReplace) {
      resolvedInputs[parameter.mediaControl.parameterId] = parameter.mediaControl.activeValue;
    }
  }
  const nodes: NodeInfo[] = [];
  for (const parameter of profile.parameters) {
    const mediaItem = mediaByParameter.get(parameter.id);
    const hasInput = Object.prototype.hasOwnProperty.call(resolvedInputs, parameter.id);
    // RunningHub's nodeInfoList is an override list, not a serialized copy of
    // the whole ComfyUI prompt. Sending every widget default can cause a node
    // to be reconstructed without its graph-only inputs (for example an
    // AudioCrop node keeps start_time/end_time widgets but loses its AUDIO
    // connection). Only send uploaded media and values that actually differ
    // from the imported workflow snapshot.
    const fieldValue = mediaItem?.uploadedValue ?? (hasInput ? resolvedInputs[parameter.id] : undefined);
    if (fieldValue === undefined) continue;
    if (mediaItem?.uploadedValue === undefined && !parameter.submitDefault && valuesEqual(fieldValue, parameter.defaultValue)) continue;
    upsertNode(nodes, parameter.nodeId, parameter.fieldName, fieldValue);
  }
  return nodes;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if ((left && typeof left === "object") || (right && typeof right === "object")) {
    try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; }
  }
  return false;
}

export function upsertNode(nodes: NodeInfo[], nodeId: string, fieldName: string, fieldValue: unknown): void {
  const existing = nodes.find(node => node.nodeId === String(nodeId) && node.fieldName === fieldName);
  if (existing) existing.fieldValue = fieldValue;
  else nodes.push({ nodeId: String(nodeId), fieldName, fieldValue });
}
