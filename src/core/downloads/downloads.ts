import path from "node:path";
import type { BackendEvents } from "../events.js";
import type { Jobs } from "../jobs/jobs.js";
import type { Logger } from "../logger.js";
import { downloadFile, safeOutputExtension } from "../runninghub/client.js";
import { classifyRunningHubError } from "../runninghub/errors.js";
import type { Job, RunningHubConfig } from "../types.js";

export class DownloadQueue {
  private readonly pending = new Set<string>();
  private readonly active = new Set<string>();
  private readonly activePromises = new Set<Promise<void>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  private running = false;

  constructor(
    private readonly config: RunningHubConfig,
    private readonly jobs: Jobs,
    private readonly events: BackendEvents,
    private readonly logger: Logger,
    private readonly fetchImpl: typeof fetch,
  ) {}

  start(): void { this.running = true; this.drain(); }
  async stop(): Promise<void> {
    this.running = false;
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    for (const controller of this.controllers.values()) controller.abort(new Error("Download queue stopped"));
    await Promise.allSettled([...this.activePromises]);
  }

  enqueue(jobId: string): void {
    this.pending.add(jobId);
    this.drain();
  }

  get activeCount(): number { return this.active.size; }
  get pendingCount(): number { return this.pending.size; }

  cancel(jobId: string): Job {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);
    if (!["DOWNLOAD_PENDING", "DOWNLOADING", "RETRY_WAIT"].includes(job.status) ||
      (job.status === "RETRY_WAIT" && job.retryPhase !== "download")) return job;
    this.pending.delete(jobId);
    const timer = this.retryTimers.get(jobId);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(jobId);
    this.controllers.get(jobId)?.abort(new Error("Download cancelled by user"));
    return this.jobs.cancel(jobId);
  }

  retryNow(jobId: string): Job {
    const timer = this.retryTimers.get(jobId);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(jobId);
    const job = this.jobs.retryDownload(jobId);
    this.enqueue(jobId);
    return job;
  }

  private drain(): void {
    if (!this.running) return;
    while (this.active.size < this.config.maxDownloads && this.pending.size > 0) {
      const jobId = this.pending.values().next().value as string;
      this.pending.delete(jobId);
      this.active.add(jobId);
      const controller = new AbortController();
      this.controllers.set(jobId, controller);
      const promise = this.downloadJob(jobId, controller.signal).finally(() => {
        this.active.delete(jobId);
        this.controllers.delete(jobId);
        this.activePromises.delete(promise);
        this.drain();
      });
      this.activePromises.add(promise);
    }
  }

  private async downloadJob(jobId: string, signal: AbortSignal): Promise<void> {
    let job = this.jobs.get(jobId);
    if (!job || job.status !== "DOWNLOAD_PENDING" || !job.outputs) return;
    const originalOutputs = job.outputs;
    job = this.jobs.transition(job.id, "DOWNLOADING", { retryPhase: null, retryAfter: null });
    this.events.emit("download.updated", job);
    try {
      const outputDir = path.resolve(job.outputDir ?? this.config.outputDir);
      const files = [];
      for (let index = 0; index < originalOutputs.files.length; index += 1) {
        const file = originalOutputs.files[index]!;
        const ext = safeOutputExtension(file);
        const destination = path.join(outputDir, `job_${job.id}_${String(index + 1).padStart(2, "0")}.${ext}`);
        const localPath = await downloadFile(this.fetchImpl, this.config, file.url, destination, signal);
        files.push({ ...file, localPath });
      }
      const outputs = { ...originalOutputs, files };
      job = this.jobs.transition(job.id, "COMPLETED", { outputs, completedAt: Date.now(), lastError: null });
      this.events.emit("download.updated", job);
    } catch (error) {
      if (this.jobs.get(job.id)?.status === "CANCELLED") return;
      this.fail(job, error);
    }
  }

  private fail(job: Job, error: unknown): void {
    const detail = classifyRunningHubError({
      message: error instanceof Error ? error.message : error,
      phase: "download",
    });
    if (!detail.retryable) {
      this.jobs.transition(job.id, "FAILED", { lastError: detail, completedAt: Date.now() });
      return;
    }
    const updated = this.jobs.transition(job.id, "RETRY_WAIT", {
      lastError: detail, retryPhase: "download", retryAfter: Date.now() + this.config.retryDelayMs,
    });
    this.events.emit("download.updated", updated);
    this.logger.warn("Download failed; generation will not be repeated", {
      jobId: job.id, accountId: job.accountId, remoteTaskId: job.remoteTaskId, phase: "DOWNLOAD",
    }, detail);
    this.queueRetry(job.id, this.config.retryDelayMs);
  }

  private queueRetry(jobId: string, delayMs: number): void {
    if (!this.running || this.retryTimers.has(jobId)) return;
    const timer = setTimeout(() => {
      this.retryTimers.delete(jobId);
      const current = this.jobs.get(jobId);
      if (!this.running || current?.status !== "RETRY_WAIT" || current.retryPhase !== "download") return;
      this.jobs.transition(jobId, "DOWNLOAD_PENDING", { retryPhase: null, retryAfter: null, lastError: null });
      this.enqueue(jobId);
    }, delayMs);
    timer.unref?.();
    this.retryTimers.set(jobId, timer);
  }
}
