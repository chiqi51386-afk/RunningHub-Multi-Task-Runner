import type { WorkflowParameter, WorkflowSemanticType, WorkflowValueType } from "../types.js";

interface Candidate {
  semanticType: WorkflowSemanticType;
  confidence: number;
  valueType?: WorkflowValueType;
}

const exact: Record<string, WorkflowSemanticType> = {
  prompt: "prompt",
  positiveprompt: "prompt",
  negativeprompt: "negative_prompt",
  negative: "negative_prompt",
  duration: "duration",
  seconds: "duration",
  videolength: "duration",
  fps: "fps",
  framerate: "fps",
  frames: "frames",
  numframes: "frames",
  framecount: "frames",
  width: "width",
  height: "height",
  aspectratio: "aspect_ratio",
  ratio: "aspect_ratio",
  resolution: "resolution",
  seed: "seed",
  noiseseed: "seed",
  randomseed: "seed",
  steps: "steps",
  numsteps: "steps",
  cfg: "cfg",
  cfgscale: "cfg",
  guidance: "cfg",
  guidancescale: "cfg",
  sampler: "sampler",
  samplername: "sampler",
  scheduler: "scheduler",
  denoise: "denoise",
  denoisestrength: "denoise",
  model: "model",
  modelname: "model",
  checkpoint: "model",
  ckptname: "model",
  lora: "lora",
  loraname: "lora",
  image: "image",
  imageurl: "image",
  video: "video",
  videourl: "video",
  audio: "audio",
  audiourl: "audio",
};

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, "");
}

export function recognizeParameters(parameters: WorkflowParameter[]): WorkflowParameter[] {
  return parameters.map(parameter => ({ ...parameter, ...recognizeParameter(parameter) }));
}

export function recognizeParameter(parameter: WorkflowParameter): Candidate {
  const field = normalize(parameter.fieldName);
  const cls = normalize(parameter.classType);
  const title = normalize(parameter.nodeTitle ?? "");
  const context = `${cls} ${title}`;

  // ResolutionSelector has three user-facing widgets. `multiple` is only
  // meaningful as dimension alignment in this node, so do not match it globally.
  if (/resolutionselector/.test(cls) && field === "megapixels") {
    return { semanticType: "resolution", confidence: 0.98, valueType: parameter.valueType };
  }
  if (/resolutionselector/.test(cls) && field === "multiple") {
    return { semanticType: "resolution_multiple", confidence: 0.98, valueType: "integer" };
  }

  if (exact[field]) {
    const semanticType = exact[field];
    let confidence = 0.82;
    if (contextSupports(semanticType, context)) confidence = 0.96;
    if (semanticType === "prompt" && /negative|负面|反向/.test(context)) {
      return { semanticType: "negative_prompt", confidence: 0.96, valueType: "string" };
    }
    return { semanticType, confidence, valueType: semanticValueType(semanticType, parameter.valueType, parameter.options) };
  }

  if (typeof parameter.defaultValue === "string") {
    if (/negative|负面|反向/.test(context) && /text|prompt|clip/.test(`${field} ${context}`)) {
      return { semanticType: "negative_prompt", confidence: 0.9, valueType: "string" };
    }
    if (isMediaField(field, "image") && /loadimage|imageinput|参考图|首帧|尾帧/.test(context)) {
      return { semanticType: "image", confidence: 0.88, valueType: "image" };
    }
    if (isMediaField(field, "video") && /loadvideo|videoinput|视频/.test(context)) {
      return { semanticType: "video", confidence: 0.88, valueType: "video" };
    }
    if (isMediaField(field, "audio") && /loadaudio|audioinput|音频/.test(context)) {
      return { semanticType: "audio", confidence: 0.88, valueType: "audio" };
    }
    if (/prompt|cliptext|提示词|生成词|描述词|正向/.test(context) && /text|string|value/.test(field)) {
      return { semanticType: "prompt", confidence: 0.78, valueType: "string" };
    }
    if (field === "text" && /^(text|string|primitive|stringmultiline|multilinetext)+$/.test(cls + title)
      && (parameter.defaultValue.length >= 80 || /subject_definitions|scene_description|prompt|镜头|画面|主体/.test(parameter.defaultValue.toLowerCase()))) {
      return { semanticType: "prompt", confidence: 0.86, valueType: "string" };
    }
    if (/^\d+\s*[x×]\s*\d+$/.test(parameter.defaultValue) || /resolution|分辨率/.test(`${field} ${context}`)) {
      return { semanticType: "resolution", confidence: 0.74, valueType: "string" };
    }
    if (/^\d+(\.\d+)?\s*:\s*\d+(\.\d+)?$/.test(parameter.defaultValue) || /aspect|ratio|宽高比|画幅/.test(`${field} ${context}`)) {
      return { semanticType: "aspect_ratio", confidence: 0.78, valueType: "string" };
    }
  }

  if (typeof parameter.defaultValue === "number") {
    if (/duration|seconds|时长/.test(`${field} ${context}`)) {
      return { semanticType: "duration", confidence: 0.76, valueType: parameter.valueType };
    }
    if (/fps|framerate|帧率/.test(`${field} ${context}`)) {
      return { semanticType: "fps", confidence: 0.76, valueType: parameter.valueType };
    }
    if (/frames|framecount|帧数/.test(`${field} ${context}`)) {
      return { semanticType: "frames", confidence: 0.74, valueType: parameter.valueType };
    }
  }

  return { semanticType: "unknown", confidence: 0.2 };
}

function isMediaField(field: string, type: "image" | "video" | "audio"): boolean {
  return field === type || field === `${type}url` || new RegExp(`^${type}\\d+$`).test(field);
}

function contextSupports(type: WorkflowSemanticType, context: string): boolean {
  const tokens: Partial<Record<WorkflowSemanticType, RegExp>> = {
    prompt: /prompt|text|clip|提示词/,
    negative_prompt: /negative|负面|反向/,
    duration: /video|duration|second|时长/,
    fps: /video|frame|fps/,
    frames: /video|frame/,
    width: /image|latent|size|width/,
    height: /image|latent|size|height/,
    resolution: /resolution|分辨率/,
    resolution_multiple: /resolution|multiple|分辨率|倍数/,
    seed: /sampler|noise|seed/,
    steps: /sampler|step/,
    cfg: /sampler|guidance|cfg/,
    sampler: /sampler/,
    scheduler: /scheduler|sampler/,
    denoise: /denoise|sampler/,
    model: /model|checkpoint|loader/,
    lora: /lora/,
    image: /image/,
    video: /video/,
    audio: /audio/,
  };
  return tokens[type]?.test(context) ?? false;
}

function semanticValueType(type: WorkflowSemanticType, fallback: WorkflowValueType, options?: unknown[]): WorkflowValueType {
  if (type === "image" || type === "video" || type === "audio") return type;
  if (["sampler", "scheduler", "model", "lora", "aspect_ratio", "resolution"].includes(type)) {
    return options?.length ? "select" : "string";
  }
  return fallback;
}
