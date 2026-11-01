import { parseFile } from "music-metadata";
import type { WorkflowProfile, InstanceType } from "../core/types.js";
import { MV_WORKFLOW_ID } from "../core/workflows/mvValidation.js";

export const H3_IDS = new Set([MV_WORKFLOW_ID, "2106577322987307010", "2106994828660080641"]);
export interface AudioRange { startSeconds?: number; endSeconds?: number }

export async function audioLength(file: string): Promise<number> {
  const result = await parseFile(file, { duration: true, skipCovers: true });
  const seconds = result.format.duration;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) throw new Error("无法读取音频时长，请检查音频文件，任务未提交");
  return seconds;
}

export async function applyAudioRange(profile: WorkflowProfile, parameters: Record<string, unknown>, supplied: Record<string, unknown>, media: { parameterId: string; localPath: string }[], range?: AudioRange) {
  const start = profile.parameters.find(p => p.key === "85.start_index")!;
  const duration = profile.parameters.find(p => p.key === "85.duration")!;
  const audio = profile.parameters.find(p => p.key === "34.audio")!;
  if (!start || !duration || !audio) throw new Error("MV 节点映射缺失");
  if (range !== undefined && (!range || typeof range !== "object" || Array.isArray(range))) throw new Error("audioRange 必须是起止时间对象");
  if (range && Object.keys(range).some(key => !["startSeconds", "endSeconds"].includes(key))) throw new Error("audioRange 包含未知字段");
  if (range && (supplied[start.id] !== undefined || supplied[duration.id] !== undefined)) throw new Error("audioRange 与旧时长参数不能同时填写");
  const file = media.find(m => m.parameterId === audio.id);
  if (!file) throw new Error("MV 必须选择音频");
  const seconds = await audioLength(file.localPath);
  const from = range?.startSeconds ?? parameters[start.id];
  const length = range ? undefined : supplied[duration.id];
  const end = range?.endSeconds ?? (length === undefined ? Math.ceil(seconds) : typeof from === "number" && typeof length === "number" ? from + length : NaN);
  if (typeof from !== "number" || !Number.isFinite(from) || from < 0 || from >= seconds) throw new Error("音频起点超出实际音频范围");
  if (typeof end !== "number" || !Number.isFinite(end) || end <= from || end > Math.ceil(seconds)) throw new Error("音频结束须大于起点，且不能超过音频向上取整后的总时长");
  parameters[start.id] = from;
  parameters[duration.id] = Number((end - from).toFixed(6));
  return { actualSeconds: seconds, startSeconds: from, endSeconds: end, durationSeconds: parameters[duration.id] };
}

/** The owner's cloud policy: choose Plus by the current resolution and duration. */
export function computeTier(workflowId: string, profile: WorkflowProfile, parameters: Record<string, unknown>, explicit?: InstanceType): InstanceType {
  if (explicit !== undefined) {
    if (explicit !== "default" && explicit !== "plus") throw new Error("instanceType 无效");
    return explicit;
  }
  if (!H3_IDS.has(workflowId)) return "default";
  const resolution = profile.parameters.find(p => p.classType === "ResolutionSelector" && p.fieldName === "megapixels");
  const duration = profile.parameters.find(p => workflowId === MV_WORKFLOW_ID ? p.key === "85.duration" : p.visible !== false && p.semanticType === "duration");
  const mp = resolution && parameters[resolution.id], seconds = duration && parameters[duration.id];
  const threshold = mp === 0.9 ? 15 : mp === 1.5 ? 13 : mp === 2 ? 12 : undefined;
  if (threshold === undefined) throw new Error("此分辨率没有预设 Plus 规则，请明确填写 instanceType");
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) throw new Error("视频时长无效");
  return seconds > threshold ? "plus" : "default";
}
