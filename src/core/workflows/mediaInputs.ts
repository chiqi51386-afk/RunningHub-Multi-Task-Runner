import type { WorkflowProfile } from "../types.js";

type Override = { mode: "replace" | "clear"; localPath?: string };
/** Resolve every known media slot, including slots omitted by an old renderer. */
export function resolveMediaInputs(profile: WorkflowProfile, inputs: Record<string, unknown>, overrides: Record<string, Override>) {
  const parameters = { ...inputs };
  const slots = profile.parameters.filter(p => ["image", "audio", "video"].includes(p.valueType));
  for (const id of Object.keys(overrides)) {
    if (!slots.some(p => p.id === id)) throw new Error(`媒体参数 ${id} 不属于当前工作流媒体输入。`);
  }
  const media: { parameterId: string; localPath: string }[] = [];
  for (const slot of slots) {
    if (slot.mappingIssue) throw new Error(slot.mappingIssue);
    const override = overrides[slot.id];
    if (override && !["replace", "clear"].includes(override.mode)) throw new Error(`媒体 ${slot.id} 的输入状态无效。`);
    parameters[slot.id] = "";
    if (override?.mode === "replace") {
      if (!override.localPath) throw new Error(`媒体 ${slot.id} 已选择上传，但没有本地文件。`);
      media.push({ parameterId: slot.id, localPath: override.localPath });
    }
    if (slot.mediaControl) {
      const control = profile.parameters.find(p => p.id === slot.mediaControl!.parameterId);
      if (!control || control.valueType !== "boolean") throw new Error(`媒体 ${slot.id} 的开关映射无效。`);
      if (override?.mode !== "replace" || slot.mediaControl.autoEnableOnReplace) {
        parameters[control.id] = override?.mode === "replace" ? slot.mediaControl.activeValue : slot.mediaControl.inactiveValue;
      }
    }
  }
  return { parameters, media };
}
