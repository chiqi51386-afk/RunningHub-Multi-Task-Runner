import type { WorkflowView, WorkflowParameterView, WorkflowSemanticType, WorkflowOutputView } from "./types.js";
import { isMediaParameter, type CreateMode } from "./task-draft.js";
import { hasDesktopBridge } from "./bridge.js";

export function migrateWorkflowView(workflow: WorkflowView): WorkflowView {
  if (hasDesktopBridge()) return workflow;
  const source = workflow;
  let parameters = source.parameters.map(parameter => migrateParameterView(parameter, source.id === "wf-h3"));
  // Browser/demo builds can retain an older WorkflowView in localStorage and
  // do not have the raw API graph available for the backend migration. Repair
  // the one known historical omission locally so old H3 profiles immediately
  // show all three ResolutionSelector widgets without asking users to clear
  // their saved data or re-import the workflow.
  const resolutionAspect = parameters.find(parameter =>
    parameter.classType === "ResolutionSelector" && parameter.fieldName === "aspect_ratio");
  if (resolutionAspect && !parameters.some(parameter =>
    parameter.classType === "ResolutionSelector" && parameter.fieldName === "multiple")) {
    parameters = [...parameters, {
      key: `${resolutionAspect.nodeId}.multiple`,
      id: parameters.some(parameter => parameter.id === "resolution_multiple")
        ? `${resolutionAspect.nodeId}_multiple`
        : "resolution_multiple",
      nodeId: resolutionAspect.nodeId,
      fieldName: "multiple",
      classType: "ResolutionSelector",
      nodeTitle: resolutionAspect.nodeTitle,
      valueType: "integer",
      semanticType: "resolution_multiple",
      defaultValue: 32,
      confidence: 1,
      min: 1,
      step: 1,
      visible: true,
      label: "尺寸倍数",
      displayOrder: 35,
    }];
  }
  return {
    ...source,
    parameters: attachMediaControls(parameters),
    parameterCount: parameters.length,
    needsReview: parameters.some(parameter => parameter.visible !== false && (parameter.semanticType === "unknown" || parameter.confidence < .7)),
  };
}

export function migrateParameterView(parameter: WorkflowParameterView, forceH3MediaToggle = false): WorkflowParameterView {
  const withWorkflowDefaults = forceH3MediaToggle && isMediaParameter(parameter) ? { ...parameter, showEnableToggle: true } : parameter;
  const badAspectGuess = withWorkflowDefaults.semanticType === "aspect_ratio" &&
    !isAspectRatioParameter(withWorkflowDefaults.fieldName, withWorkflowDefaults.classType, withWorkflowDefaults.nodeTitle ?? "");
  const base = badAspectGuess ? { ...withWorkflowDefaults, semanticType: "unknown" as const, confidence: .2 } : withWorkflowDefaults;
  if (base.semanticType !== "unknown") return withBuiltinSchema({ ...base, visible: base.visible ?? shouldExposeParameter(base) });
  const mediaType = inferMediaType(base.fieldName, base.classType, base.nodeTitle ?? "");
  const semanticType = mediaType ?? inferParameterType(base.fieldName, base.classType, base.nodeTitle ?? "", base.defaultValue);
  const recognized = semanticType ? { ...base, semanticType, valueType: mediaType ?? base.valueType, confidence: .86 } : base;
  return withBuiltinSchema({ ...recognized, visible: recognized.visible ?? shouldExposeParameter(recognized) });
}

const resolutionSelectorAspectOptions = [
  "1:1 (Square)", "2:3 (Portrait Photo)", "3:2 (Photo)",
  "3:4 (Portrait Standard)", "4:3 (Standard)",
  "9:16 (Portrait Widescreen)", "16:9 (Widescreen)", "21:9 (Ultrawide)",
];

function withBuiltinSchema(parameter: WorkflowParameterView): WorkflowParameterView {
  if (parameter.classType === "ResolutionSelector" && parameter.fieldName === "aspect_ratio") {
    return { ...parameter, semanticType: "aspect_ratio", valueType: "select", defaultValue: "9:16 (Portrait Widescreen)", submitDefault: true, options: resolutionSelectorAspectOptions, confidence: 1, displayOrder: 10 };
  }
  if (parameter.classType === "ResolutionSelector" && parameter.fieldName === "megapixels") {
    return { ...parameter, semanticType: parameter.semanticType === "target_resolution" ? "target_resolution" : "resolution", valueType: "number", min: 0.1, max: 16, step: 0.1, confidence: 1, displayOrder: 30 };
  }
  if (parameter.classType === "ResolutionSelector" && parameter.fieldName === "multiple") {
    return { ...parameter, semanticType: "resolution_multiple", valueType: "integer", min: 1, step: 1, confidence: 1, displayOrder: 35 };
  }
  return parameter;
}

export const semanticLabels: Partial<Record<WorkflowSemanticType, string>> = {
  target_resolution: "目标分辨率", lowres_scale: "低分辨率阶段比例",
  prompt: "提示词", negative_prompt: "负面提示词", image: "图片", video: "视频", audio: "音频",
  duration: "时长", fps: "帧率", frames: "帧数", width: "宽度", height: "高度",
  aspect_ratio: "画面比例", resolution: "分辨率", resolution_multiple: "尺寸倍数", upscale_factor: "二采放大倍数", seed: "随机种子", steps: "采样步数",
  cfg: "CFG", sampler: "采样器", scheduler: "调度器", denoise: "降噪强度", model: "模型", lora: "LoRA",
};

export function discoverParameters(raw: Record<string, unknown>): WorkflowParameterView[] {
  const found: WorkflowParameterView[] = [];
  const semanticCounts = new Map<string, number>();
  const optionalReferenceMedia = detectOptionalReferenceMedia(raw);
  const nodeIds = new Set(Object.keys(raw));
  for (const [nodeId, candidate] of Object.entries(raw)) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const node = candidate as Record<string, unknown>;
    const inputs = node.inputs;
    if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) continue;
    const meta = node._meta && typeof node._meta === "object" && !Array.isArray(node._meta) ? node._meta as Record<string, unknown> : {};
    const classType = typeof node.class_type === "string" ? node.class_type : "UnknownNode";
    const nodeTitle = typeof meta.title === "string" ? meta.title : classType;
    for (const [fieldName, defaultValue] of Object.entries(inputs as Record<string, unknown>)) {
      if (Array.isArray(defaultValue) && defaultValue.length === 2 && nodeIds.has(String(defaultValue[0])) && Number.isInteger(defaultValue[1])) continue;
      const primitive = typeof defaultValue;
      if (!["string", "number", "boolean", "object"].includes(primitive) || defaultValue === null) continue;
      const inferredMedia = inferMediaType(fieldName, classType, nodeTitle);
      const inferred = inferredMedia ?? inferParameterType(fieldName, classType, nodeTitle, defaultValue);
      const valueType = inferredMedia ?? (primitive === "boolean" ? "boolean" : primitive === "number" ? (Number.isInteger(defaultValue) ? "integer" : "number") : primitive === "object" ? "json" : "string");
      const semanticType = inferred ?? "unknown";
      const idBase = inferred ?? `${nodeId}_${fieldName}`;
      const occurrence = (semanticCounts.get(idBase) ?? 0) + 1;
      semanticCounts.set(idBase, occurrence);
      const parameter: WorkflowParameterView = { id: occurrence === 1 ? idBase : `${idBase}_${occurrence}`, key: `${nodeId}.${fieldName}`, nodeId, fieldName, classType, nodeTitle, valueType, semanticType, defaultValue, confidence: inferred ? .9 : 0, showEnableToggle: optionalReferenceMedia.has(nodeId) && /^(image|audio|video)$/i.test(fieldName) };
      const complete = withBuiltinSchema(parameter);
      found.push({ ...complete, visible: shouldExposeParameter(complete) });
    }
  }
  return attachMediaControls(found);
}

function detectOptionalReferenceMedia(raw: Record<string, unknown>): Set<string> {
  const sources = new Set<string>();
  const isLink = (value: unknown): value is [string | number, number] => Array.isArray(value) && value.length === 2
    && (typeof value[0] === "string" || typeof value[0] === "number") && Number.isInteger(value[1]);
  const visit = (value: unknown, path: string[]): void => {
    if (isLink(value)) {
      if (/ref(?:erence)?[_-]?(?:images?|audios?|videos?)/i.test(path.join("."))) sources.add(String(value[0]));
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) visit(child, [...path, key]);
  };
  for (const candidate of Object.values(raw)) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const inputs = (candidate as Record<string, unknown>).inputs;
    if (inputs && typeof inputs === "object") visit(inputs, []);
  }
  return sources;
}

function inferParameterType(fieldName: string, classType: string, nodeTitle: string, value: unknown): WorkflowSemanticType | undefined {
  const field = normalizeToken(fieldName);
  const context = normalizeToken(`${classType} ${nodeTitle}`);
  if (["prompt", "positiveprompt", "positive", "textprompt"].includes(field)) return "prompt";
  if (["negativeprompt", "negative", "negprompt"].includes(field)) return "negative_prompt";
  if (typeof value === "string" && field === "text" && /^(text|string|primitive|stringmultiline|multilinetext)+$/.test(context)
    && (value.length >= 80 || /subjectdefinitions|scenedescription|prompt|镜头|画面|主体/.test(normalizeToken(value)))) return "prompt";
  if (typeof value === "string" && /negative|负面|反向/.test(context) && /text|prompt/.test(field + context)) return "negative_prompt";
  if (typeof value === "string" && /prompt|提示词|生成词|描述词|正向|cliptext/.test(context) && /text|string|value/.test(field)) return "prompt";
  if (/duration|seconds|时长/.test(field + context)) return "duration";
  if (isAspectRatioParameter(fieldName, classType, nodeTitle)) return "aspect_ratio";
  if (/resolutionselector/.test(normalizeToken(classType)) && field === "multiple") return "resolution_multiple";
  if (/resolution|分辨率|megapixels/.test(field + context)) return "resolution";
  if (/seed|随机种子/.test(field + context)) return "seed";
  return undefined;
}

function isAspectRatioParameter(fieldName: string, classType: string, nodeTitle: string): boolean {
  const field = normalizeToken(fieldName);
  const context = normalizeToken(`${classType} ${nodeTitle}`);
  return field === "aspectratio" || ((field === "ratio" || field === "value") && /aspectratio|宽高比|画幅|分辨率选择/.test(context));
}

export function shouldExposeParameter(parameter: Pick<WorkflowParameterView, "semanticType" | "valueType">): boolean {
  return parameter.semanticType !== "unknown" || ["image", "video", "audio"].includes(parameter.valueType);
}

export function discoverOutputs(raw: Record<string, unknown>): WorkflowOutputView[] {
  const outputs: WorkflowOutputView[] = [];
  for (const [nodeId, candidate] of Object.entries(raw)) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const node = candidate as Record<string, unknown>;
    const inputs = node.inputs && typeof node.inputs === "object" && !Array.isArray(node.inputs) ? node.inputs as Record<string, unknown> : {};
    const meta = node._meta && typeof node._meta === "object" && !Array.isArray(node._meta) ? node._meta as Record<string, unknown> : {};
    const classType = typeof node.class_type === "string" ? node.class_type : "UnknownNode";
    const nodeTitle = typeof meta.title === "string" ? meta.title : classType;
    const context = `${classType} ${nodeTitle}`.toLowerCase();
    const mediaType = /video.*combine|save.*video|video.*output|视频.*输出|合成.*视频/.test(context) ? "video" : /save.*image|preview.*image|image.*output|图片.*输出/.test(context) ? "image" : /save.*audio|preview.*audio|audio.*output|音频.*输出/.test(context) ? "audio" : undefined;
    if (!mediaType) continue;
    const filenamePrefix = typeof inputs.filename_prefix === "string" ? inputs.filename_prefix : undefined;
    const label = filenamePrefix || nodeTitle;
    const normalized = label.toLowerCase();
    const stage = /一采|第一次|first|stage\s*1|pass\s*1/.test(normalized) ? 1 : /二采|第二次|second|stage\s*2|pass\s*2/.test(normalized) ? 2 : Number(normalized.match(/(?:stage|pass|采样|输出)[^0-9]*([0-9]+)/)?.[1] ?? 1);
    outputs.push({ id: `output_${nodeId}`, nodeId, classType, nodeTitle, mediaType, label, filenamePrefix, saveOutput: typeof inputs.save_output === "boolean" ? inputs.save_output : undefined, stage });
  }
  return outputs.sort((a, b) => a.stage - b.stage || Number(a.nodeId) - Number(b.nodeId));
}

export function attachMediaControls(parameters: WorkflowParameterView[]): WorkflowParameterView[] {
  const switches = parameters.filter(parameter => parameter.valueType === "boolean");
  return parameters.map(media => {
    if (!isMediaParameter(media) || media.mediaControl) return media;
    const mediaContext = normalizeToken(`${media.fieldName} ${media.classType} ${media.nodeTitle ?? ""}`);
    const mediaNumber = mediaContext.match(/\d+/)?.[0];
    const candidates = switches.map(control => {
      const field = normalizeToken(control.fieldName);
      const context = normalizeToken(`${control.fieldName} ${control.classType} ${control.nodeTitle ?? ""}`);
      if (!/enable|enabled|use|active|upload|switch|toggle|启用|开启|使用|上传/.test(context)) return { control, score: -1 };
      let score = control.nodeId === media.nodeId ? 100 : 0;
      if (context.includes(media.valueType) || (media.valueType === "image" && /图片|图像|参考图/.test(context)) || (media.valueType === "video" && /视频/.test(context)) || (media.valueType === "audio" && /音频|声音/.test(context))) score += 30;
      if (mediaNumber && context.includes(mediaNumber)) score += 20;
      if (/^(enable|enabled|use|active|upload|switch|toggle)$/.test(field)) score += 10;
      return { control, score };
    }).filter(candidate => candidate.score >= 30).sort((a, b) => b.score - a.score);
    if (!candidates[0] || (candidates[1] && candidates[0].score === candidates[1].score)) return media;
    return { ...media, showEnableToggle: true, mediaControl: { parameterId: candidates[0].control.id, activeValue: true, inactiveValue: false, autoEnableOnReplace: true, detected: true } };
  });
}

function normalizeToken(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, "");
}

function inferMediaType(fieldName: string, classType: string, nodeTitle: string): "image" | "video" | "audio" | undefined {
  const field = fieldName.toLowerCase().replace(/[^a-z0-9]/g, "");
  const context = `${classType} ${nodeTitle}`.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, "");
  if ((field === "image" || /^image\d+$/.test(field)) && /image|参考图|首帧|尾帧|图片|图像/.test(context)) return "image";
  if ((field === "video" || /^video\d+$/.test(field)) && /video|参考视频|视频/.test(context)) return "video";
  if ((field === "audio" || /^audio\d+$/.test(field)) && /audio|音频|声音/.test(context)) return "audio";
  return undefined;
}

export function parameterLabel(parameter: WorkflowParameterView) {
  return parameter.label ?? semanticLabels[parameter.semanticType] ?? parameter.nodeTitle ?? parameter.fieldName;
}

export function optionParts(option: unknown) {
  if (option && typeof option === "object" && !Array.isArray(option) && "value" in option) {
    const item = option as { label?: unknown; value: unknown };
    return { label: String(item.label ?? item.value), value: item.value };
  }
  return { label: String(option ?? ""), value: option };
}


const digitalHumanWorkflowIds = new Set([
  "2100933451562491906",
  "2101727071255941122",
]);

const h3MultiReferenceWorkflowIds = new Set([
  "2093983063180054529",
  "2101869007837089794",
  "2103877636870156290",
  "2104088262948556801",
  "2104087390590894081",
]);

export function createModeForWorkflow(workflow?: WorkflowView): CreateMode {
  if (workflow?.builtIn === false) return "personal";
  if (workflow?.runningHubWorkflowId === "2106577322987307010") return "h3-multi-reference";
  if (workflow?.runningHubWorkflowId === "2106994828660080641") return "h3-first-last";
  if (["2107063778012905474", "2104101064866140162"].includes(workflow?.runningHubWorkflowId ?? "")) return "h3-mv";
  if (!workflow) return "digital-human";
  if (h3MultiReferenceWorkflowIds.has(workflow.runningHubWorkflowId)) return "h3-multi-reference";
  if (digitalHumanWorkflowIds.has(workflow.runningHubWorkflowId)) return "digital-human";
  return "personal";
}

const generationParameterPriority: Partial<Record<WorkflowSemanticType, number>> = {
  aspect_ratio: 10,
  duration: 20,
  resolution: 30,
  target_resolution: 30,
  lowres_scale: 40,
  resolution_multiple: 35,
  upscale_factor: 40,
};

export function generationParameterOrder(parameter: WorkflowParameterView): number {
  return parameter.displayOrder ?? generationParameterPriority[parameter.semanticType] ?? 999;
}

export function isPromptOptimizationControl(parameter: WorkflowParameterView): boolean {
  return parameter.id === "chinese_prompt_optimization" && parameter.key === "328.value"
    && parameter.classType === "easy boolean" && parameter.valueType === "boolean";
}
