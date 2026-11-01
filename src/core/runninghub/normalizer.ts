import type { JobResult, JobResultFile } from "../types.js";

type JsonObject = Record<string, unknown>;

export interface NormalizedRunningHubTask {
  taskId?: string;
  status?: string;
  errorCode?: string;
  errorMessage?: string;
  failedReason?: unknown;
  files: JobResultFile[];
  texts: string[];
  usage?: unknown;
  raw: unknown;
}

export type RemoteTaskState = "QUEUED" | "RUNNING" | "SUCCESS" | "FAILED" | "CANCELLED" | "RETRYABLE_QUERY_ERROR" | "UNKNOWN";

export function classifyRemoteTaskResponse(raw: unknown): RemoteTaskState {
  const normalized = normalizeRunningHubResponse(raw);
  const status = normalized.status;
  if (status === "SUCCESS") return "SUCCESS";
  if (status === "FAILED") return "FAILED";
  if (status === "CANCEL" || status === "CANCELLED") return "CANCELLED";
  if (status === "RUNNING") return "RUNNING";
  if (status === "CREATE" || status === "QUEUED" || status === "PENDING") return "QUEUED";
  if (normalized.errorCode === "805" || /APIKEY_TASK_STATUS_ERROR|工作流运行失败/i.test(normalized.errorMessage ?? "")) {
    return normalized.failedReason != null || !status ? "FAILED" : "RETRYABLE_QUERY_ERROR";
  }
  if (normalized.errorCode && normalized.errorCode !== "0") return "RETRYABLE_QUERY_ERROR";
  return "UNKNOWN";
}

export function asObject(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

export function normalizeRunningHubResponse(raw: unknown): NormalizedRunningHubTask {
  const root = asObject(raw);
  const data = asObject(root.data);
  const taskId = firstString(root.taskId, root.task_id, data.taskId, data.task_id);
  const status = firstString(root.status, data.status)?.toUpperCase();
  const errorCode = firstString(root.errorCode, root.error_code, root.code, data.errorCode, data.error_code);
  const errorMessage = firstString(root.errorMessage, root.error_message, root.message, root.msg, data.errorMessage, data.error_message);
  const resultValues = Array.isArray(root.results) ? root.results
    : Array.isArray(data.results) ? data.results
    : Array.isArray(root.data) ? root.data
    : [];
  const files: JobResultFile[] = [];
  const texts: string[] = [];
  for (const value of resultValues) {
    const item = asObject(value);
    const url = [item.url, item.fileUrl, item.file_url, item.outputUrl, item.download_url]
      .find((value): value is string => typeof value === "string" && !!value.trim())?.trim();
    if (url) {
      files.push({
        url,
        type: firstString(item.fileType, item.file_type, item.outputType, item.output_type, item.type),
        nodeId: firstString(item.nodeId, item.node_id),
        label: firstString(item.label, item.name, item.filename, item.fileName),
      });
      continue;
    }
    const text = item.text ?? item.content ?? item.output;
    const declaresFile = ["fileUrl", "file_url", "url", "outputUrl", "download_url"].some(key => key in item)
      || /^(video|audio|image|mp4|mov|webm|mp3|wav|png|jpg|jpeg|webp)$/i.test(firstString(item.fileType,item.outputType,item.type) ?? "");
    if (!declaresFile && text != null && String(text).trim()) texts.push(String(text));
  }
  return {
    taskId, status, errorCode, errorMessage,
    failedReason: root.failedReason ?? root.failed_reason ?? data.failedReason ?? data.failed_reason,
    files, texts, usage: root.usage ?? data.usage, raw,
  };
}

/** Missing or partial outputs are a query problem, never permission to run again. */
export function hasIncompleteOutputs(raw: unknown): boolean {
  const root=asObject(raw), data=asObject(root.data);
  const results=Array.isArray(root.results)?root.results:Array.isArray(data.results)?data.results:Array.isArray(root.data)?root.data:[];
  const normalized=normalizeRunningHubResponse(raw);
  const count=normalized.files.length+normalized.texts.length;
  return count===0 || count<results.length;
}

export function normalizedJobResult(taskId: string, raw: unknown): JobResult {
  const normalized = normalizeRunningHubResponse(raw);
  return { taskId, files: normalized.files, texts: normalized.texts, usage: normalized.usage, raw };
}

export function extractUploadValue(raw: unknown): string | undefined {
  const root = asObject(raw);
  const data = asObject(root.data);
  return firstString(data.fileName, data.filename);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return undefined;
}
