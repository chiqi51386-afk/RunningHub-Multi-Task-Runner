import path from "node:path";
import type { RunningHubConfig } from "./types.js";

export const DEFAULT_RUNNINGHUB_CONFIG: RunningHubConfig = {
  apiHost: "https://www.runninghub.cn",
  pollIntervalMs: 5_000,
  pollJitterMs: 500,
  maxPollingMs: 30 * 60_000,
  requestTimeoutMs: 60_000,
  uploadTimeoutMs: 120_000,
  downloadTimeoutMs: 300_000,
  maxQueryFailures: 5,
  accountFreshnessMs: 5 * 60_000,
  maxDownloads: 3,
  outputDir: path.resolve("downloads"),
};

export function resolveConfig(overrides: Partial<RunningHubConfig> = {}): RunningHubConfig {
  const config = { ...DEFAULT_RUNNINGHUB_CONFIG, ...overrides };
  config.apiHost = config.apiHost.replace(/\/+$/, "");
  return config;
}

export function openApiBase(config: RunningHubConfig): string {
  return `${config.apiHost}/openapi/v2`;
}
