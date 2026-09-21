import type { AccountStatus, JobResult, NodeInfo, PollOptions, RunningHubClientLike } from "../types.js";
import { classifyRunningHubError, RunningHubError, terminalTaskError } from "./errors.js";
import { normalizedJobResult, normalizeRunningHubResponse } from "./normalizer.js";

export type MockStep = Record<string, unknown> | Error;

export interface MockRunningHubScenario {
  account?: AccountStatus | Error;
  upload?: { value: string; raw?: unknown } | Error;
  submit?: { taskId: string } | Error;
  query?: MockStep[];
  cancel?: Error;
  stepDelayMs?: number;
}

export class MockRunningHubClient implements RunningHubClientLike {
  readonly calls = { account: 0, upload: 0, submit: 0, query: 0, cancel: 0 };
  readonly submissions: Array<{ workflowId: string; nodeInfoList: NodeInfo[] }> = [];
  private queryIndex = 0;

  constructor(private readonly scenario: MockRunningHubScenario = {}) {}

  async accountStatus(): Promise<AccountStatus> {
    this.calls.account += 1;
    if (this.scenario.account instanceof Error) throw this.scenario.account;
    return this.scenario.account ?? { valid: true, balance: "100", coins: "100", currentTaskCount: 0, raw: { mock: true } };
  }

  async uploadMedia(filePath: string): Promise<{ value: string; raw: unknown }> {
    this.calls.upload += 1;
    if (this.scenario.upload instanceof Error) throw this.scenario.upload;
    const value = this.scenario.upload?.value ?? `mock/${filePath.split(/[\\/]/).pop() ?? "media"}`;
    return { value, raw: this.scenario.upload?.raw ?? { code: 0, data: { fileName: value } } };
  }

  async runWorkflow(workflowId: string, nodeInfoList: NodeInfo[]): Promise<string> {
    this.calls.submit += 1;
    this.submissions.push({ workflowId, nodeInfoList: structuredClone(nodeInfoList) });
    if (this.scenario.submit instanceof Error) throw this.scenario.submit;
    return this.scenario.submit?.taskId ?? `mock-task-${this.calls.submit}`;
  }

  async pollTask(taskId: string, options: PollOptions = {}): Promise<JobResult> {
    while (true) {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error("Aborted");
      if (this.scenario.stepDelayMs) await delay(this.scenario.stepDelayMs, options.signal);
      const step = await this.queryTask(taskId);
      const status = normalizeRunningHubResponse(step).status ?? "UNKNOWN";
      await options.onStatus?.(status, step);
      if (status === "SUCCESS") return normalizedJobResult(taskId, step);
      if (status === "FAILED" || status === "CANCEL") {
        const detail = terminalTaskError(step, status);
        throw new RunningHubError(detail.message, detail);
      }
      if (!this.scenario.query?.length) throw new Error("Mock query has no terminal step.");
    }
  }

  async queryTask(_taskId: string): Promise<Record<string, unknown>> {
    this.calls.query += 1;
    const steps: MockStep[] = this.scenario.query?.length
      ? this.scenario.query
      : [{ status: "SUCCESS", results: [{ text: "mock complete" }] }];
    const step = steps[Math.min(this.queryIndex++, steps.length - 1)]!;
    if (step instanceof Error) throw step;
    return step;
  }

  async cancelTask(_taskId: string): Promise<void> {
    this.calls.cancel += 1;
    if (this.scenario.cancel) throw this.scenario.cancel;
  }
}

export function mockRunningHubError(input: { code?: unknown; message: string; phase?: "account" | "upload" | "submit" | "query" | "download" | "cancel" }): RunningHubError {
  const detail = classifyRunningHubError({ code: input.code, message: input.message, phase: input.phase ?? "query" });
  return new RunningHubError(detail.message, detail);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("Aborted"));
    const finish = () => { signal?.removeEventListener("abort", onAbort); resolve(); };
    const timer = setTimeout(finish, ms);
    const onAbort = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); reject(signal?.reason ?? new Error("Aborted")); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
