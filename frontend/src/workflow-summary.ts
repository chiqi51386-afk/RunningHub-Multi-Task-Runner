import type { WorkflowView } from "./types";

export function importSummary(workflow: WorkflowView) {
  const count = (type: "image" | "video" | "audio") => workflow.parameters.filter(item => item.valueType === type).length;
  const switches = workflow.parameters.filter(item => item.showEnableToggle || item.mediaControl).length;
  return `检测完成：${workflow.parameters.length} 个参数，图片 ${count("image")} 个，视频 ${count("video")} 个，音频 ${count("audio")} 个，关联开关 ${switches} 个。`;
}
