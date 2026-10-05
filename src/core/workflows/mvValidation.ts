import type { WorkflowProfile } from "../types.js";

export const MV_WORKFLOW_ID = "2107063778012905474";
/** Validate the exact API targets, not inferred semantic names. */
export function validateMvInput(profile: WorkflowProfile, parameters: Record<string, unknown>, media: { parameterId: string; localPath: string }[]) {
  const parameter = (key: string, classType: string) => {
    const match = profile.parameters.filter(p => p.key === key && p.classType === classType && p.key === p.nodeId + "." + p.fieldName);
    if (match.length !== 1) throw new Error(`MV 节点映射无效：${key}`);
    return match[0]!;
  };
  const prompt = parameters[parameter("87.value", "PrimitiveStringMultiline").id];
  const start = parameters[parameter("85.start_index", "TrimAudioDuration").id];
  const duration = parameters[parameter("85.duration", "TrimAudioDuration").id];
  const audio = parameter("34.audio", "LoadAudio");
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("MV 生成词不能为空");
  if (!media.some(m => m.parameterId === audio.id && m.localPath)) throw new Error("MV 必须选择音频");
  if (typeof start !== "number" || !Number.isFinite(start) || start < 0) throw new Error("MV 音频起点必须是非负秒数");
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) throw new Error("MV 片段时长必须大于 0 秒（结束时间须大于起点）");
  for (const key of ["61.aspect_ratio", "61.megapixels"]) {
    const p = parameter(key, "ResolutionSelector");
    const value = parameters[p.id];
    if (key.endsWith("megapixels") && (typeof value !== "number" || !Number.isFinite(value) || value <= 0)) throw new Error("MV 分辨率无效");
    if (p.options?.length && !p.options.some(option => JSON.stringify(option) === JSON.stringify(value))) throw new Error("MV 参数不在可选范围内");
  }
}
