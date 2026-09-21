import type { WorkflowOutput, WorkflowParameter, WorkflowProfile, WorkflowProfileParameter } from "../types.js";
import { recognizeParameter, recognizeParameters } from "./recognizer.js";

export function createWorkflowProfile(input: {
  workflowId: string;
  name: string;
  version: number;
  parameters: WorkflowParameter[];
  outputs?: WorkflowOutput[];
  now?: number;
  createdAt?: number;
}): WorkflowProfile {
  const now = input.now ?? Date.now();
  const recognized = recognizeParameters(input.parameters);
  const counts = new Map<string, number>();
  const profileParameters: WorkflowProfileParameter[] = recognized.map(parameter => {
    const base = parameter.semanticType === "unknown"
      ? `${parameter.nodeId}_${parameter.fieldName}`
      : parameter.semanticType;
    const count = (counts.get(base) ?? 0) + 1;
    counts.set(base, count);
    return { ...parameter, id: count === 1 ? base : `${base}_${count}`, visible: parameter.visible ?? isUserFacing(parameter) };
  });
  bindMediaControls(profileParameters);
  const genericParameters = profileParameters.filter(item => item.semanticType === "unknown");
  return {
    version: input.version,
    workflowId: input.workflowId,
    name: input.name,
    parameters: profileParameters,
    genericParameters,
    needsReview: profileParameters.some(item => item.visible !== false && item.confidence < 0.7),
    outputs: structuredClone(input.outputs ?? []),
    createdAt: input.createdAt ?? now,
    updatedAt: now,
  };
}

/** Upgrade only untouched detector misses; never overwrite reviewed/user-edited semantics. */
export function repairLowConfidenceSemantics(parameters: WorkflowProfileParameter[]): WorkflowProfileParameter[] {
  return parameters.map(parameter => {
    if (parameter.semanticType !== "unknown" || parameter.confidence > 0.2) return parameter;
    const recognized = recognizeParameter(parameter);
    if (recognized.semanticType === "unknown") return parameter;
    const repaired = { ...parameter, ...recognized };
    // Low-confidence `unknown` entries were auto-hidden by older detectors.
    // Once confidently recognized, expose them as normal user-facing inputs.
    return { ...repaired, visible: isUserFacing(repaired) };
  });
}

function isUserFacing(parameter: WorkflowParameter): boolean {
  return ["prompt", "negative_prompt", "image", "video", "audio", "duration", "fps", "frames", "width", "height", "aspect_ratio", "resolution", "resolution_multiple", "upscale_factor", "seed", "steps", "cfg", "sampler", "scheduler", "denoise", "model", "lora"].includes(parameter.semanticType);
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, "");
}

function bindMediaControls(parameters: WorkflowProfileParameter[]): void {
  const switches = parameters.filter(parameter => parameter.valueType === "boolean");
  for (const media of parameters.filter(parameter => ["image", "video", "audio"].includes(parameter.valueType))) {
    const mediaType = media.valueType;
    const mediaContext = normalize(`${media.fieldName} ${media.classType} ${media.nodeTitle ?? ""}`);
    const mediaNumber = mediaContext.match(/\d+/)?.[0];
    const candidates = switches.map(parameter => {
      const field = normalize(parameter.fieldName);
      const context = normalize(`${parameter.fieldName} ${parameter.classType} ${parameter.nodeTitle ?? ""}`);
      const isSwitch = /enable|enabled|use|active|upload|switch|toggle|启用|开启|使用|上传/.test(context);
      if (!isSwitch) return { parameter, score: -1 };
      let score = parameter.nodeId === media.nodeId ? 100 : 0;
      if (context.includes(mediaType) || (mediaType === "image" && /图片|图像|参考图/.test(context)) || (mediaType === "video" && /视频/.test(context)) || (mediaType === "audio" && /音频|声音/.test(context))) score += 30;
      if (mediaNumber && context.includes(mediaNumber)) score += 20;
      if (/^(enable|enabled|use|active|upload|switch|toggle)$/.test(field)) score += 10;
      return { parameter, score };
    }).filter(candidate => candidate.score >= 30).sort((a, b) => b.score - a.score);
    const best = candidates[0];
    const second = candidates[1];
    if (best && (!second || best.score > second.score)) {
      media.mediaControl = {
        parameterId: best.parameter.id,
        activeValue: true,
        inactiveValue: false,
        autoEnableOnReplace: true,
        detected: true,
      };
    }
  }
}

export function validateProfile(profile: WorkflowProfile): void {
  const ids = new Set<string>();
  for (const parameter of profile.parameters) {
    if (!parameter.id || !parameter.nodeId || !parameter.fieldName) {
      throw new Error("Workflow profile parameters require id, nodeId, and fieldName.");
    }
    if (ids.has(parameter.id)) throw new Error(`Duplicate workflow profile parameter id: ${parameter.id}`);
    ids.add(parameter.id);
  }
  for (const parameter of profile.parameters) {
    if (!parameter.mediaControl) continue;
    const control = profile.parameters.find(item => item.id === parameter.mediaControl?.parameterId);
    if (!control || control.valueType !== "boolean") {
      throw new Error(`Media parameter ${parameter.id} references an invalid boolean control: ${parameter.mediaControl.parameterId}`);
    }
  }
}

export function validateProfileAgainstWorkflow(profile: WorkflowProfile, raw: Record<string, unknown>): void {
  for (const parameter of profile.parameters) {
    const node = raw[parameter.nodeId];
    const inputs = node && typeof node === "object" && !Array.isArray(node)
      ? (node as Record<string, unknown>).inputs
      : undefined;
    if (!inputs || typeof inputs !== "object" || Array.isArray(inputs) || !(parameter.fieldName in inputs)) {
      throw new Error(`工作流包含失效参数映射：${parameter.nodeId}.${parameter.fieldName}`);
    }
  }
  for (const output of profile.outputs) {
    const node = raw[output.nodeId];
    if (!node || typeof node !== "object" || Array.isArray(node)) throw new Error(`工作流包含失效输出节点：${output.nodeId}`);
  }
}
