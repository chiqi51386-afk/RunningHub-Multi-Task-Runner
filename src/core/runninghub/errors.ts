import type { JobError, JobErrorCode, JobPhase } from "../types.js";
import { asObject, normalizeRunningHubResponse } from "./normalizer.js";

const SECRET_PATTERNS = [
  /(api[_-]?key\s*[=:]\s*)[^&\s,}\]]+/gi,
  /(authorization\s*:\s*bearer\s+)[A-Za-z0-9._-]+/gi,
  /(bearer\s+)[A-Za-z0-9._-]+/gi,
];

export function maskSecrets(value: string): string {
  return SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, "$1****"), value);
}

export class RunningHubError extends Error {
  constructor(
    message: string,
    readonly detail: JobError,
    readonly cause?: unknown,
  ) {
    super(maskSecrets(message));
    this.name = "RunningHubError";
  }
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function userFacingMessage(rawMessage: string, input: { code?: unknown; httpStatus?: number; phase: JobPhase }): string {
  const remoteCode = input.code == null ? undefined : String(input.code);
  if (remoteCode === "1004") return "远端任务不存在或已过期，无法继续查询。";
  if (input.phase !== "query") return rawMessage;
  if (input.httpStatus !== undefined && input.httpStatus >= 500) {
    return `RunningHub 状态查询服务暂时不可用（HTTP ${input.httpStatus}），软件将使用原 taskId 自动重试。`;
  }
  if (/fetch failed|network|socket|econn|enotfound|connection/i.test(rawMessage)) {
    return "网络连接暂时中断，软件将使用原 taskId 自动重试。";
  }
  if (/timeout|timed out|aborterror/i.test(rawMessage)) {
    return "任务状态查询超时，软件将使用原 taskId 自动重试。";
  }
  if (/^(?:\{\}|\[\]|null|undefined|\[object Object\])$/i.test(rawMessage.trim())) {
    return "任务状态查询暂时失败，软件将使用原 taskId 自动重试。";
  }
  return rawMessage;
}

export function classifyRunningHubError(input: {
  message?: unknown;
  code?: unknown;
  httpStatus?: number;
  phase: JobPhase;
  raw?: unknown;
}): JobError {
  const remoteCode = input.code == null ? undefined : String(input.code);
  const rawMessage = maskSecrets(textOf(input.message ?? "RunningHub request failed")).slice(0, 1_000);
  const message = userFacingMessage(rawMessage, input);
  // Classification must inspect the original technical detail even when the
  // persisted/displayed message is localized for the user.
  const combined = `${remoteCode ?? ""} ${input.httpStatus ?? ""} ${rawMessage}`.toLowerCase();
  let code: JobErrorCode = "UNKNOWN";
  let retryable = false;
  let accountRelated = false;
  let safeToReassign = false;

  if (remoteCode === "1004" || /task not found|任务不存在|任务已过期/.test(combined)) {
    code = "TASK_FAILED";
  } else if (input.phase === "download" && input.httpStatus !== undefined && input.httpStatus >= 400 && input.httpStatus < 500) {
    code = "DOWNLOAD_FAILED";
  } else if (remoteCode === "605" || /insufficient|balance|余额|remainmoney|credit|quota/.test(combined)) {
    code = "ACCOUNT_NO_BALANCE"; accountRelated = true; safeToReassign = input.phase !== "query";
  } else if (remoteCode === "1007" || input.httpStatus === 400 || /invalid parameter|参数错误/.test(combined)) {
    code = "INVALID_PARAMETER";
  } else if (remoteCode === "433" || /node_info_mismatch|field_not_found_in_node_inputs|node_errors|graph validation|workflow validation|节点校验|webapp\s+not\s+exists|workflow\s+not\s+exists/.test(combined)) {
    code = "WORKFLOW_VALIDATION";
  } else if (input.httpStatus === 401 || input.httpStatus === 403 || /invalid.*key|unauthori[sz]ed|鉴权|token expired/.test(combined)) {
    code = "ACCOUNT_INVALID_KEY"; accountRelated = true; safeToReassign = input.phase !== "query";
  } else if (input.httpStatus === 429 || /rate.?limit|too many requests/.test(combined)) {
    code = "RATE_LIMIT"; retryable = true; accountRelated = true; safeToReassign = input.phase !== "query";
  } else if (/concurren|currenttaskcounts|busy|queue.*(?:full|capacity|limit)|capacity.*(?:full|limit)|队列.*(?:已满|上限)/.test(combined)) {
    code = "CONCURRENCY_LIMIT"; retryable = true; accountRelated = true; safeToReassign = input.phase !== "query";
  } else if (/timeout|timed out|aborterror/.test(combined)) {
    code = "TIMEOUT"; retryable = input.phase !== "submit";
  } else if (input.httpStatus !== undefined && input.httpStatus >= 500) {
    code = "SERVER_ERROR"; retryable = input.phase !== "submit";
  } else if (/fetch failed|network|socket|econn|enotfound|connection/.test(combined)) {
    code = "NETWORK_ERROR"; retryable = input.phase !== "submit";
  } else if (input.phase === "upload") {
    code = "UPLOAD_FAILED"; retryable = true;
  } else if (input.phase === "query") {
    code = "QUERY_FAILED"; retryable = true;
  } else if (input.phase === "download") {
    code = "DOWNLOAD_FAILED"; retryable = true;
  } else if (input.phase === "cancel") {
    code = "CANCEL_FAILED";
  }

  return {
    code,
    message,
    phase: input.phase,
    retryable,
    accountRelated,
    safeToReassign,
    httpStatus: input.httpStatus,
    remoteCode,
    raw: input.raw,
  };
}

export function submitUnknown(error: unknown): JobError {
  const message = error instanceof Error ? error.message : textOf(error);
  return {
    code: "SUBMIT_UNKNOWN",
    message: maskSecrets(message).slice(0, 1_000),
    phase: "submit",
    retryable: false,
    accountRelated: false,
    safeToReassign: false,
  };
}

/** A FAILED/CANCEL query result is final, never a transient query failure. */
export function terminalTaskError(raw: unknown, status = "FAILED"): JobError {
  const normalized = normalizeRunningHubResponse(raw);
  const failed = asObject(normalized.failedReason);
  const nodeId = firstText(failed.node_id, failed.nodeId);
  const nodeName = firstText(failed.node_name, failed.nodeName);
  const exception = firstText(failed.exception_message, failed.exceptionMessage, failed.message);
  const node = nodeId || nodeName
    ? `节点${nodeId ? ` ${nodeId}` : ""}${nodeName ? `（${nodeName}）` : ""}`
    : undefined;
  const reason = exception && /cuda.*out of memory|out of memory.*cuda|cuda error: out of memory/i.test(exception)
    ? "CUDA 显存不足"
    : exception?.split(/\r?\n/).map(line => line.trim()).find(Boolean)?.slice(0, 500);
  const fallback = status.toUpperCase() === "CANCEL" ? "远端任务已取消" : "工作流运行失败";
  const summary = [normalized.errorMessage ?? fallback, node && reason ? `${node}：${reason}` : node ?? reason]
    .filter(Boolean).join("；");
  return {
    code: status.toUpperCase() === "CANCEL" ? "CANCEL_FAILED" : "TASK_FAILED",
    message: maskSecrets(summary).slice(0, 1_000),
    phase: "query",
    retryable: false,
    accountRelated: false,
    safeToReassign: false,
    remoteCode: normalized.errorCode,
    raw,
    nodeId,
    nodeName,
  };
}

function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return undefined;
}
