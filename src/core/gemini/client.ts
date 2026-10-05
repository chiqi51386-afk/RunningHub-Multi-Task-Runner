import type { GeminiGenerateInput } from "./types.js";
import { setTimeout as delay } from "node:timers/promises";

export type GeminiFailureKind = "auth" | "rate_limit" | "transient" | "config" | "content" | "cancelled";
export class GeminiError extends Error {
  constructor(message: string, readonly kind: GeminiFailureKind, readonly retryAfterMs = 60_000) { super(message); }
}
type JsonObject = Record<string, any>;

export function httpError(status: number, body: JsonObject, retryAfter: string | null): GeminiError {
  // Match structured codes only; never return provider messages that may echo secrets or input.
  const details: unknown[] = Array.isArray(body.error?.details) ? body.error.details : [];
  const reasons = details.map(v => (v as JsonObject)?.reason).filter(v => typeof v === "string");
  if (status === 401 || reasons.some(r => /API_KEY_(INVALID|EXPIRED)/.test(r))) return new GeminiError("API Key 无效或已过期，请更新后检测。", "auth", 300_000);
  if (status === 403) return new GeminiError("当前 Key 无访问权限，请检查项目、API 限制或地区支持。", "auth", 300_000);
  if (status === 429) {
    const retryInfo = details.find(v => typeof (v as JsonObject)?.retryDelay === "string") as JsonObject | undefined;
    const seconds = retryAfter && /^\d+(\.\d+)?$/.test(retryAfter) ? Number(retryAfter) : Number.parseFloat(retryInfo?.retryDelay ?? "");
    const dateDelay = retryAfter ? Date.parse(retryAfter) - Date.now() : NaN;
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(dateDelay) ? dateDelay : 60_000;
    return new GeminiError("Google 项目限流或额度不足，冷却后可重试。", "rate_limit", Math.max(1000, Math.min(delay, 24 * 3600_000)));
  }
  if (status >= 500 || status === 408) return new GeminiError(`Google 服务暂时不可用（${status}），稍后重试。`, "transient", 30_000);
  if (status === 404) return new GeminiError("模型不存在或项目无法使用该模型，请检查模型名称。", "config");
  return new GeminiError(`Google 请求失败（${status}），请检查模型及请求参数。`, "config");
}

export function validateGeminiInput(input: GeminiGenerateInput): void {
  if (!input || typeof input.text !== "string" || !input.text.trim() || input.text.length > 100_000) throw new GeminiError("生成词不能为空或超过长度限制。", "config");
  if (input.systemInstruction !== undefined && (typeof input.systemInstruction !== "string" || input.systemInstruction.length > 200_000)) throw new GeminiError("生成词规则无效。", "config");
  if (input.maxOutputTokens !== undefined && (!Number.isInteger(input.maxOutputTokens) || input.maxOutputTokens < 128 || input.maxOutputTokens > 8192)) throw new GeminiError("输出长度无效。", "config");
  if (input.thinkingLevel !== undefined && !["low","medium","high"].includes(input.thinkingLevel)) throw new GeminiError("思考级别无效。", "config");
  const indexes = new Set<number>();
  let bytes = 0;
  if (input.images !== undefined && (!Array.isArray(input.images) || input.images.length > 9)) throw new GeminiError("最多支持 9 张参考图片。", "config");
  for (const image of input.images ?? []) {
    if (!Number.isInteger(image.referenceIndex) || image.referenceIndex < 1 || image.referenceIndex > 9 || indexes.has(image.referenceIndex) || !["image/jpeg","image/png","image/webp"].includes(image.mimeType) || typeof image.data !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) throw new GeminiError("参考图片或图片编号无效。", "config");
    indexes.add(image.referenceIndex); bytes += image.data.length;
  }
  if (bytes > 16 * 1024 * 1024) throw new GeminiError("参考图片总大小过大，请先缩小图片。", "config");
  if(input.audio){
    if(!['audio/wav','audio/mpeg','audio/mp3','audio/aac','audio/flac','audio/ogg','audio/mp4'].includes(input.audio.mimeType)||typeof input.audio.data!=='string'||!input.audio.data.length||!/^[A-Za-z0-9+/]+={0,2}$/.test(input.audio.data))throw new GeminiError('音频数据无效。','config');
    bytes+=input.audio.data.length;
  }
  if(bytes>18*1024*1024)throw new GeminiError('优化素材超过单次请求大小，请将音频压缩为 MP3 或缩小图片；未提交视频任务。','config');
}

/** Official Interactions REST API. No shared conversation state between tasks. */
export async function generateGemini(apiKey: string, model: string, input: GeminiGenerateInput, options: {fetch?: typeof fetch; signal?: AbortSignal; timeoutMs?: number; retryDelayMs?: number} = {}): Promise<string> {
  validateGeminiInput(input);
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 90_000);
  const signal = options.signal ? AbortSignal.any([options.signal,timeout]) : timeout;
  const parts: JsonObject[] = [{type:"text",text:input.text}];
  if(input.audio)parts.push({type:'text',text:'Source audio. Only use the segment specified in audioSegment; do not use other portions.'},{type:'audio',mime_type:input.audio.mimeType,data:input.audio.data});
  for (const image of [...(input.images ?? [])].sort((a,b) => a.referenceIndex-b.referenceIndex)) {
    parts.push({type:"text",text:`<Picture ${image.referenceIndex}>`}, {type:"image",mime_type:image.mimeType,data:image.data});
  }
  try {
    for (let attempt = 0; ; attempt++) {
    const response = await (options.fetch ?? fetch)("https://generativelanguage.googleapis.com/v1beta/interactions", {
      method:"POST", redirect:"error", signal,
      headers:{"Content-Type":"application/json","x-goog-api-key":apiKey},
      body:JSON.stringify({model,input:parts,system_instruction:input.systemInstruction,store:false,stream:false,
        generation_config:{max_output_tokens:input.maxOutputTokens ?? 8192,...(input.thinkingLevel?{thinking_level:input.thinkingLevel}:{})}}),
    });
    const body = await response.json().catch(() => ({})) as JsonObject;
    signal.throwIfAborted();
    if (!response.ok) {
      // A model service failure is not evidence that the credential is invalid.
      if ([408,500,502,503,504].includes(response.status) && attempt < 2) {
        await delay(options.retryDelayMs ?? (1000 * 2 ** attempt + Math.floor(Math.random()*300)), undefined, {signal});
        continue;
      }
      throw httpError(response.status,body,response.headers.get("retry-after"));
    }
    if (body.status !== "completed") throw new GeminiError("Google 未返回完整结果，请重试；未提交视频任务。", "content");
    const outputs = Array.isArray(body.steps) ? body.steps.filter((step: JsonObject) => step.type === "model_output") : [];
    const content = outputs.at(-1)?.content;
    const text = Array.isArray(content) ? content.filter((part: JsonObject) => part.type === "text" && typeof part.text === "string").map((part: JsonObject) => part.text).join("\n").trim() : "";
    if (!text) throw new GeminiError("Google 未返回有效文本，可能被内容过滤，请调整内容后重试。", "content");
    return text;
    }
  } catch (error) {
    if (options.signal?.aborted) throw new GeminiError("Google 请求已取消。", "cancelled");
    if (error instanceof GeminiError) throw error;
    throw new GeminiError(timeout.aborted ? "Google 请求超时，请检查网络后重试。" : "无法连接 Google API，请检查网络后重试。", "transient",30_000);
  }
}
