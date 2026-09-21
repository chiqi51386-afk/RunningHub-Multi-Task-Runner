import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { openApiBase } from "../config.js";
import type {
  AccountStatus,
  JobResult,
  JobResultFile,
  NodeInfo,
  PollOptions,
  RunningHubConfig,
} from "../types.js";
import { classifyRunningHubError, maskSecrets, RunningHubError, terminalTaskError } from "./errors.js";
import { asObject, classifyRemoteTaskResponse, extractUploadValue, normalizedJobResult, normalizeRunningHubResponse } from "./normalizer.js";

interface RequestOptions {
  phase: "account" | "upload" | "submit" | "query" | "download" | "cancel";
  timeoutMs: number;
  retries?: number;
}

type JsonObject = Record<string, unknown>;

function messageFrom(data: JsonObject, fallback: string): string {
  return normalizeRunningHubResponse(data).errorMessage ?? fallback;
}

function codeFrom(data: JsonObject): unknown {
  return normalizeRunningHubResponse(data).errorCode;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("Aborted"));
    const finish = () => { signal?.removeEventListener("abort", onAbort); resolve(); };
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function jitter(base: number, amount: number): number {
  return Math.max(0, base + Math.round((Math.random() * 2 - 1) * amount));
}

export class RunningHubClient {
  readonly openApiBase: string;

  constructor(
    private readonly apiKey: string,
    private readonly config: RunningHubConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!apiKey.trim()) throw new Error("RunningHub API key is required.");
    this.openApiBase = openApiBase(config);
  }

  async accountStatus(): Promise<AccountStatus> {
    const data = await this.requestJson(
      `${this.config.apiHost}/uc/openapi/accountStatus`,
      {
        method: "POST",
        headers: this.jsonHeaders(),
        body: JSON.stringify({ apikey: this.apiKey }),
      },
      { phase: "account", timeoutMs: Math.min(this.config.requestTimeoutMs, 15_000), retries: 1 },
    );
    const code = codeFrom(data);
    if (code !== undefined && Number(code) !== 0) {
      throw this.apiError(data, "account", undefined, "Account status failed");
    }
    const body = asObject(data.data);
    const balance = body.remainMoney == null ? undefined : String(body.remainMoney);
    const currentTaskCount = body.currentTaskCounts == null ? undefined : Number(body.currentTaskCounts);
    return {
      valid: true,
      balance,
      coins: body.remainCoins == null ? undefined : String(body.remainCoins),
      currentTaskCount: Number.isFinite(currentTaskCount) ? currentTaskCount : undefined,
      apiType: body.apiType == null ? undefined : String(body.apiType),
      raw: data,
    };
  }

  async uploadMedia(filePath: string): Promise<{ value: string; raw: unknown }> {
    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile()) {
      throw new RunningHubError(`File does not exist: ${filePath}`, {
        code: "MEDIA_INVALID", message: `File does not exist: ${filePath}`, phase: "upload",
        retryable: false, accountRelated: false, safeToReassign: false,
      });
    }
    const bytes = await readFile(filePath);
    const form = new FormData();
    form.append("file", new Blob([bytes]), path.basename(filePath));
    const data = await this.requestJson(
      `${this.openApiBase}/media/upload/binary`,
      { method: "POST", headers: { Authorization: `Bearer ${this.apiKey}` }, body: form },
      { phase: "upload", timeoutMs: this.config.uploadTimeoutMs, retries: 2 },
    );
    if (Number(data.code) !== 0) throw this.apiError(data, "upload", undefined, "Upload failed");
    const value = extractUploadValue(data);
    if (!value) {
      throw new RunningHubError("Upload succeeded without data.fileName, data.filename, or data.download_url", {
        code: "UPLOAD_FAILED", message: "Upload response is missing a reusable media value", phase: "upload",
        retryable: false, accountRelated: false, safeToReassign: false, raw: data,
      });
    }
    return { value, raw: data };
  }

  /** Submit exactly once. Transport ambiguity must be handled as SUBMIT_UNKNOWN by the caller. */
  async runWorkflow(workflowId: string, nodeInfoList: NodeInfo[]): Promise<string> {
    if (!workflowId.trim()) throw new Error("workflowId is required");
    const data = await this.requestJson(
      `${this.openApiBase}/run/workflow/${encodeURIComponent(workflowId.trim())}`,
      {
        method: "POST",
        headers: this.jsonHeaders(),
        body: JSON.stringify({ nodeInfoList }),
      },
      { phase: "submit", timeoutMs: this.config.requestTimeoutMs, retries: 0 },
    );
    if (data.code !== undefined && Number(data.code) !== 0) {
      throw this.apiError(data, "submit", undefined, "Workflow submit failed");
    }
    const nested = asObject(data.data);
    const taskId = normalizeRunningHubResponse(data).taskId;
    if (!taskId) {
      throw this.apiError(data, "submit", undefined, "Submit response is missing taskId");
    }
    const promptTips = nested.promptTips;
    if (typeof promptTips === "string" && promptTips.includes("node_errors")) {
      throw this.apiError({ ...data, code: 433, message: promptTips }, "submit", 400, "Workflow validation failed");
    }
    return taskId;
  }

  async queryTask(taskId: string): Promise<JsonObject> {
    const data = await this.requestJson(
      `${this.openApiBase}/query`,
      {
        method: "POST",
        headers: this.jsonHeaders(),
        body: JSON.stringify({ taskId }),
      },
      { phase: "query", timeoutMs: Math.min(this.config.requestTimeoutMs, 30_000), retries: 2 },
    );
    // RunningHub reports query failures (for example an expired/missing task)
    // as HTTP 200 responses. Treat their business errorCode as an error instead
    // of polling an empty status forever.
    const normalized = normalizeRunningHubResponse(data);
    if (classifyRemoteTaskResponse(data) === "FAILED") {
      const detail = terminalTaskError(data, "FAILED");
      throw new RunningHubError(detail.message, detail);
    }
    const code = normalized.errorCode;
    if (!normalized.status && code !== undefined && Number(code) !== 0) {
      throw this.apiError(data, "query", undefined, "Task query failed");
    }
    return data;
  }

  async cancelTask(taskId: string): Promise<void> {
    if (!taskId.trim()) throw new Error("taskId is required");
    const data = await this.requestJson(
      `${this.config.apiHost}/task/openapi/cancel`,
      {
        method: "POST",
        headers: this.jsonHeaders(),
        body: JSON.stringify({ apiKey: this.apiKey, taskId: taskId.trim() }),
      },
      { phase: "cancel", timeoutMs: Math.min(this.config.requestTimeoutMs, 30_000), retries: 0 },
    );
    const code = codeFrom(data);
    if (code !== undefined && Number(code) !== 0) {
      throw this.apiError(data, "cancel", undefined, "取消 RunningHub 任务失败");
    }
  }

  async pollTask(taskId: string, options: PollOptions = {}): Promise<JobResult> {
    const started = Date.now();
    const maxMs = options.maxPollingMs ?? this.config.maxPollingMs;
    const interval = options.intervalMs ?? this.config.pollIntervalMs;
    let failures = 0;
    while (Date.now() - started < maxMs) {
      await sleep(jitter(interval, this.config.pollJitterMs), options.signal);
      try {
        const response = await this.queryTask(taskId);
        failures = 0;
        const normalized = normalizeRunningHubResponse(response);
        const status = normalized.status ?? "UNKNOWN";
        const remoteState = classifyRemoteTaskResponse(response);
        await options.onStatus?.(status, response);
        if (remoteState === "SUCCESS") return parseJobResult(taskId, response);
        if (remoteState === "FAILED" || remoteState === "CANCELLED") {
          const detail = terminalTaskError(response, remoteState === "CANCELLED" ? "CANCEL" : "FAILED");
          throw new RunningHubError(detail.message, detail);
        }
      } catch (error) {
        if (error instanceof RunningHubError && !error.detail.retryable) throw error;
        failures += 1;
        if (failures >= this.config.maxQueryFailures) throw error;
      }
    }
    throw new RunningHubError(`Task ${taskId} exceeded polling timeout`, {
      code: "TIMEOUT", message: `Task ${taskId} exceeded polling timeout`, phase: "query",
      retryable: true, accountRelated: false, safeToReassign: false,
    });
  }

  async download(url: string, destination: string): Promise<string> {
    return downloadFile(this.fetchImpl, this.config, url, destination);
  }

  private jsonHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" };
  }

  private async requestJson(url: string, init: RequestInit, options: RequestOptions): Promise<JsonObject> {
    const retries = options.retries ?? 0;
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error(`${options.phase} timeout`)), options.timeoutMs);
      try {
        const response = await this.fetchImpl(url, { ...init, signal: controller.signal, redirect: "follow" });
        const bodyText = await response.text();
        let parsed: unknown;
        try { parsed = bodyText ? JSON.parse(bodyText) : {}; }
        catch {
          const detail = classifyRunningHubError({
            message: `Invalid JSON response: ${bodyText.slice(0, 500)}`,
            httpStatus: response.status,
            phase: options.phase,
          });
          throw new RunningHubError(detail.message, detail);
        }
        const data = asObject(parsed);
        if (!response.ok) throw this.apiError(data, options.phase, response.status, bodyText);
        return data;
      } catch (error) {
        lastError = error;
        const detail = error instanceof RunningHubError
          ? error.detail
          : classifyRunningHubError({ message: error instanceof Error ? error.message : error, phase: options.phase });
        const canRetry = attempt < retries && detail.retryable && options.phase !== "submit";
        if (!canRetry) {
          if (error instanceof RunningHubError) throw error;
          throw new RunningHubError(detail.message, detail, error);
        }
        await sleep(500 * 2 ** attempt);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError;
  }

  private apiError(data: JsonObject, phase: RequestOptions["phase"], status?: number, fallback = "Request failed"): RunningHubError {
    const detail = classifyRunningHubError({
      message: messageFrom(data, fallback),
      code: codeFrom(data),
      httpStatus: status,
      phase,
      raw: sanitizeRaw(data),
    });
    if (phase === "submit") detail.confirmedSubmitFailure = true;
    return new RunningHubError(detail.message, detail);
  }
}

export async function downloadFile(
  fetchImpl: typeof fetch,
  config: RunningHubConfig,
  url: string,
  destination: string,
  signal?: AbortSignal,
): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Download timeout")), config.downloadTimeoutMs);
    const temp = `${destination}.part`;
    try {
      const requestSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
      const response = await fetchImpl(url, { signal: requestSignal, redirect: "follow" });
      if (!response.ok || !response.body) {
        const message = `HTTP ${response.status}: ${await response.text().catch(() => "")}`;
        const detail = classifyRunningHubError({ message, httpStatus: response.status, phase: "download" });
        throw new RunningHubError(detail.message, detail);
      }
      await mkdir(path.dirname(destination), { recursive: true });
      await pipeline(Readable.fromWeb(response.body as never), createWriteStream(temp));
      await rename(temp, destination);
      return destination;
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      if (error instanceof RunningHubError) throw error;
      const detail = classifyRunningHubError({ message: error, phase: "download" });
      throw new RunningHubError(detail.message, detail, error);
    } finally {
      clearTimeout(timer);
    }
  }

function sanitizeRaw(value: unknown): unknown {
  const text = maskSecrets(JSON.stringify(value));
  if (text.length > 8_000) return `${text.slice(0, 8_000)}…`;
  try { return JSON.parse(text); } catch { return text; }
}

export function parseJobResult(taskId: string, raw: JsonObject): JobResult {
  return normalizedJobResult(taskId, raw);
}

export function safeOutputExtension(file: JobResultFile): string {
  const declared = String(file.type ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (/^(png|jpg|jpeg|webp|gif|mp4|mov|webm|mp3|wav|m4a|txt|json)$/.test(declared)) return declared;
  try {
    const ext = path.extname(new URL(file.url).pathname).slice(1).toLowerCase();
    if (/^[a-z0-9]{1,5}$/.test(ext)) return ext;
  } catch {}
  return "bin";
}
