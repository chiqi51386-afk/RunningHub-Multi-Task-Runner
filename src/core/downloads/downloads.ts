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
    await Promise.allSettled([...this.activePromises]);
  }

  enqueue(jobId: string): void {
    this.pending.add(jobId);
    this.drain();
  }

  get activeCount(): number { return this.active.size; }
  get pendingCount(): number { return this.pending.size; }

  private drain(): void {
    if (!this.running) return;
    while (this.active.size < this.config.maxDownloads && this.pending.size > 0) {
      const jobId = this.pending.values().next().value as string;
      this.pending.delete(jobId);
      this.active.add(jobId);
      const promise = this.downloadJob(jobId).finally(() => {
        this.active.delete(jobId);
        this.activePromises.delete(promise);
        this.drain();
      });
      this.activePromises.add(promise);
    }
  }

  private async downloadJob(jobId: string): Promise<void> {
    let job = this.jobs.get(jobId);
    if (!job || job.status !== "DOWNLOAD_PENDING" || !job.outputs) return;
    if (!job.accountId) {
      this.fail(job, new Error("Job has no account affinity for download client."));
      return;
    }
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
        const localPath = await downloadFile(this.fetchImpl, this.config, file.url, destination);
        files.push({ ...file, localPath });
      }
      const outputs = { ...originalOutputs, files };
      job = this.jobs.transition(job.id, "COMPLETED", { outputs, completedAt: Date.now(), lastError: null });
      this.events.emit("download.updated", job);
    } catch (error) {
      this.fail(job, error);
    }
  }

  private fail(job: Job, error: unknown): void {
    const detail = classifyRunningHubError({
      message: error instanceof Error ? error.message : error,
      phase: "download",
    });
    const updated = this.jobs.transition(job.id, "RETRY_WAIT", {
      lastError: detail, retryPhase: "download", retryAfter: Date.now() + 10_000,
    });
    this.events.emit("download.updated", updated);
    this.logger.warn("Download failed; generation will not be repeated", {
      jobId: job.id, accountId: job.accountId, remoteTaskId: job.remoteTaskId, phase: "DOWNLOAD",
    }, detail);
  }
}
