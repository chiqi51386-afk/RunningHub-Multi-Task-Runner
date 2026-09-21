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
    const url = firstString(item.url, item.fileUrl, item.file_url, item.outputUrl, item.download_url);
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
    if (text != null) texts.push(String(text));
  }
  return {
    taskId, status, errorCode, errorMessage,
    failedReason: root.failedReason ?? root.failed_reason ?? data.failedReason ?? data.failed_reason,
    files, texts, usage: root.usage ?? data.usage, raw,
  };
}

export function normalizedJobResult(taskId: string, raw: unknown): JobResult {
  const normalized = normalizeRunningHubResponse(raw);
  return { taskId, files: normalized.files, texts: normalized.texts, usage: normalized.usage, raw };
}

export function extractUploadValue(raw: unknown): string | undefined {
  const root = asObject(raw);
  const data = asObject(root.data);
  return firstString(data.fileName, data.filename, data.download_url, data.downloadUrl);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return undefined;
}
