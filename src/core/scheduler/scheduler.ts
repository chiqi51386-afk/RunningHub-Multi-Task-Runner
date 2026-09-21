import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { AccountPool } from "../accounts/accountPool.js";
import type { CoreDatabase } from "../database.js";
import type { DownloadQueue } from "../downloads/downloads.js";
import type { BackendEvents } from "../events.js";
import type { Jobs } from "../jobs/jobs.js";
import type { Logger } from "../logger.js";
import { buildNodeInfoList } from "../workflows/nodeInfo.js";
import { RunningHubError, submitUnknown, terminalTaskError } from "../runninghub/errors.js";
import { normalizedJobResult, normalizeRunningHubResponse } from "../runninghub/normalizer.js";
import type { AccountState, Job, JobError, RunningHubConfig } from "../types.js";

export class Scheduler {
  private running = false;
  private scheduling = false;
  private readonly activeJobs = new Set<string>();
  private readonly activePromises = new Set<Promise<void>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  private accountWakeTimer?: NodeJS.Timeout;
  private accountWakeAt?: number;

  constructor(
    private readonly db: CoreDatabase,
    private readonly config: RunningHubConfig,
    private readonly accounts: AccountPool,
    private readonly jobs: Jobs,
    private readonly downloads: DownloadQueue,
    private readonly events: BackendEvents,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.downloads.start();
    await this.recoverJobs();
    const unchecked = this.accounts.list().filter(account => account.enabled && account.state === "UNCHECKED");
    for (const [index, account] of unchecked.entries()) {
      await this.accounts.refresh(account.id);
      if (index < unchecked.length - 1) await new Promise(resolve => setTimeout(resolve, 350));
    }
    await this.schedule();
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    if (this.accountWakeTimer) clearTimeout(this.accountWakeTimer);
    this.accountWakeTimer = undefined;
    this.accountWakeAt = undefined;
    for (const controller of this.controllers.values()) controller.abort(new Error("Backend stopped"));
    await Promise.allSettled([...this.activePromises]);
    await this.downloads.stop();
  }

  /** Cancel queued local work or stop an already-submitted RunningHub task. */
  async cancel(jobId: string): Promise<Job> {
    let job = this.jobs.get(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);
    if (["DOWNLOAD_PENDING", "DOWNLOADING"].includes(job.status) ||
      (job.status === "RETRY_WAIT" && job.retryPhase === "download")) return this.downloads.cancel(jobId);
    if (["REMOTE_SUCCESS", "COMPLETED", "FAILED", "CANCELLED", "SUBMIT_UNKNOWN"]
      .includes(job.status)) return job;
    const hasActiveRemoteGeneration = job.status === "REMOTE_QUEUED" || job.status === "RUNNING" ||
      (job.status === "RETRY_WAIT" && job.retryPhase === "query");
    if (job.remoteTaskId && hasActiveRemoteGeneration) {
      if (!job.accountId) throw new Error("任务已经提交，但找不到用于取消任务的账号。");
      const { client } = this.accounts.clientFor(job.accountId);
      try {
        await client.cancelTask(job.remoteTaskId);
        // A successful cancel response only confirms that RunningHub accepted
        // the request.  It does not prove that the task was cancelled: the
        // task may have completed while the request was in flight.  Query the
        // authoritative remote state before changing the local terminal state.
        const response = await client.queryTask(job.remoteTaskId);
        const status = normalizeRunningHubResponse(response).status ?? "UNKNOWN";
        const reconciled = this.reconcileRemoteAfterCancel(jobId, response, status);
        if (reconciled) return reconciled;
      } catch (error) {
        // RunningHub may remove a task immediately after accepting a cancel.
        // Both the cancel endpoint and the authoritative follow-up query can
        // then answer 1004. For an explicit user cancellation this is the
        // desired terminal outcome, not an error dialog.
        if (isRemoteTaskMissing(error)) return this.finishMissingRemoteCancellation(jobId);
        if (!isApiKeyCancelNotAllowed(error)) throw error;
        let response: Record<string, unknown>;
        try {
          response = await client.queryTask(job.remoteTaskId);
        } catch (queryError) {
          if (!(queryError instanceof RunningHubError) || queryError.detail.retryable ||
            !queryError.detail.raw || typeof queryError.detail.raw !== "object") throw queryError;
          response = queryError.detail.raw as Record<string, unknown>;
        }
        const status = normalizeRunningHubResponse(response).status ?? "UNKNOWN";
        const reconciled = this.reconcileRemoteAfterCancel(jobId, response, status);
        if (reconciled) return reconciled;
        const detail: JobError = {
          code: "CANCEL_FAILED",
          message: "RunningHub 不允许 API Key 取消这个任务；任务仍在远端运行，软件会继续跟踪并在完成后自动下载。",
          phase: "cancel", retryable: false, accountRelated: false, safeToReassign: false,
          remoteCode: error instanceof RunningHubError ? error.detail.remoteCode : "APIKEY_TASK_CANCEL_NOT_ALLOWED",
        };
        throw new RunningHubError(detail.message, detail, error);
      }
      job = this.jobs.get(jobId) ?? job;
      if (["REMOTE_SUCCESS", "DOWNLOAD_PENDING", "DOWNLOADING", "COMPLETED", "FAILED", "CANCELLED"]
        .includes(job.status)) return job;
      // RunningHub accepted the stop request but still reports a live state.
      // Keep polling the original taskId until the remote side confirms a
      // terminal state instead of displaying a false local cancellation.
      return job;
    }
    this.stopLocalTracking(jobId);
    const cancelled = this.jobs.cancel(jobId);
    if (job.accountId) {
      this.accounts.release(job.accountId, job.id, false, "IDLE");
    }
    return cancelled;
  }

  private reconcileRemoteAfterCancel(jobId: string, response: Record<string, unknown>, status: string): Job | undefined {
    const current = this.jobs.get(jobId);
    if (!current) throw new Error(`Job not found: ${jobId}`);
    if (["REMOTE_SUCCESS", "DOWNLOAD_PENDING", "DOWNLOADING", "COMPLETED"].includes(current.status)) return current;
    if (status === "FAILED" || status === "CANCEL" || status === "CANCELLED") {
      this.stopLocalTracking(jobId);
      const detail = terminalTaskError(response, status);
      const terminal = this.jobs.transition(current.id, status === "CANCEL" || status === "CANCELLED" ? "CANCELLED" : "FAILED", {
        lastError: status === "FAILED" ? detail : null,
        completedAt: Date.now(),
      });
      if (current.accountId) this.accounts.release(current.accountId, current.id, false, "IDLE");
      return terminal;
    }
    if (status === "SUCCESS" && current.remoteTaskId) {
      this.stopLocalTracking(jobId);
      const result = normalizedJobResult(current.remoteTaskId, response);
      let succeeded = this.jobs.transition(current.id, "REMOTE_SUCCESS", {
        outputs: result, rawResult: result.raw, remoteCompletedAt: Date.now(), lastError: null,
      });
      if (current.accountId) this.accounts.release(current.accountId, current.id, true, "IDLE");
      succeeded = this.jobs.transition(succeeded.id, "DOWNLOAD_PENDING");
      this.downloads.enqueue(succeeded.id);
      return succeeded;
    }
    return undefined;
  }

  private finishMissingRemoteCancellation(jobId: string): Job {
    this.stopLocalTracking(jobId);
    const current = this.jobs.get(jobId);
    if (!current) throw new Error(`Job not found: ${jobId}`);
    if (["REMOTE_SUCCESS", "DOWNLOAD_PENDING", "DOWNLOADING", "COMPLETED"].includes(current.status)) return current;
    const cancelled = current.status === "CANCELLED" ? current : this.jobs.recoverTransition(jobId, "CANCELLED", {
      lastError: null, retryPhase: null, retryAfter: null, completedAt: Date.now(),
    });
    if (current.accountId) this.accounts.release(current.accountId, current.id, false, "IDLE");
    return cancelled;
  }

  async schedule(): Promise<void> {
    if (!this.running || this.scheduling) return;
    this.scheduling = true;
    try {
      while (this.running && this.db.pendingCount() > 0) {
        let available = this.accounts.available();
        if (!available.length) {
          const candidates = this.accounts.list().filter(account => account.enabled && !account.currentJobId &&
            (["UNCHECKED", "REMOTE_BUSY", "TEMP_UNAVAILABLE"].includes(account.state) ||
              (account.state === "COOLDOWN" && (account.cooldownUntil ?? 0) <= Date.now())));
          const staleCandidates = candidates.filter(account => account.state === "COOLDOWN" || !this.accounts.isFresh(account));
          if (staleCandidates.length) {
            for (const account of staleCandidates) await this.accounts.refresh(account.id);
            available = this.accounts.available();
          } else if (candidates.length) {
            const nextCheckAt = Math.min(...candidates.map(account => (account.lastCheckedAt ?? 0) + this.config.accountFreshnessMs));
            this.queueAccountWake(Math.max(10, nextCheckAt - Date.now()));
          }
          const futureCooldowns = this.accounts.list().filter(account => account.enabled && !account.currentJobId &&
            account.state === "COOLDOWN" && (account.cooldownUntil ?? 0) > Date.now());
          if (futureCooldowns.length) {
            const wakeAt = Math.min(...futureCooldowns.map(account => account.cooldownUntil!));
            this.queueAccountWake(Math.max(10, wakeAt - Date.now()));
          }
          if (!available.length) break;
        }
        const stale = available.filter(account => !this.accounts.isFresh(account));
        if (stale.length) {
          for (const account of stale) await this.accounts.refresh(account.id);
          available = this.accounts.available();
        }
        if (!available.length) break;
        let claimedAny = false;
        for (const account of available) {
          if (!this.running) break;
          const job = this.db.claimNextJob(account.id);
          if (!job) continue;
          claimedAny = true;
          this.events.emit("account.updated", this.db.getAccount(account.id)!);
          this.events.emit("job.updated", job);
          this.events.emit("queue.updated", this.db.pendingCount());
          this.launch(job.id);
        }
        if (!claimedAny) break;
      }
    } finally {
      this.scheduling = false;
    }
  }

  private launch(jobId: string): void {
    if (this.activeJobs.has(jobId) || !this.running) return;
    this.activeJobs.add(jobId);
    const controller = new AbortController();
    this.controllers.set(jobId, controller);
    const promise = this.runJob(jobId, controller.signal).finally(() => {
      this.activeJobs.delete(jobId);
      this.activePromises.delete(promise);
      this.controllers.delete(jobId);
      const current = this.jobs.get(jobId);
      if (this.running && current?.status === "ASSIGNED") this.launch(jobId);
      else void this.schedule();
    });
    this.activePromises.add(promise);
  }

  private async runJob(jobId: string, signal: AbortSignal): Promise<void> {
    let job = this.jobs.get(jobId);
    if (!job?.accountId) return;
    const accountId = job.accountId;
    const { client } = this.accounts.clientFor(accountId);
    const context = { jobId: job.id, accountId, remoteTaskId: job.remoteTaskId };
    try {
      if (!job.remoteTaskId) {
        const originalMedia = job.media;
        const mediaForAccount = originalMedia.map(item => !item.uploadedValue || item.uploadedAccountId === accountId
          ? item
          : { ...item, uploadedValue: undefined, uploadedAccountId: undefined, uploadedAt: undefined, rawUploadResponse: undefined });
        if (mediaForAccount.some((item, index) => item !== originalMedia[index])) {
          job = this.db.updateJob(job.id, { media: mediaForAccount });
          this.events.emit("job.updated", job);
        }
        if (job.media.some(item => !item.uploadedValue)) {
          if (job.status === "ASSIGNED") job = this.jobs.transition(job.id, "UPLOADING");
          const media = structuredClone(job.media);
          try {
            for (let index = 0; index < media.length; index += 1) {
              const item = media[index]!;
              if (item.uploadedValue) continue;
              const file = await readFileWithHash(item.localPath);
              const cached = this.db.getMediaUploadCache(job.accountId!, file.hash, this.config.mediaCacheTtlMs);
              if (cached) {
                media[index] = { ...item, uploadedValue: cached.runningHubValue, uploadedAccountId: job.accountId!, uploadedAt: cached.uploadedAt };
                job = this.db.updateJob(job.id, { media });
                this.events.emit("job.updated", job);
                continue;
              }
              const uploaded = await client.uploadMedia(item.localPath);
              media[index] = { ...item, uploadedValue: uploaded.value, uploadedAccountId: job.accountId!, uploadedAt: Date.now(), rawUploadResponse: uploaded.raw };
              this.db.saveMediaUploadCache({
                accountId: job.accountId!, fileHash: file.hash, fileSize: file.size,
                originalPath: item.localPath, runningHubValue: uploaded.value,
              });
              job = this.db.updateJob(job.id, { media });
              this.events.emit("job.updated", job);
            }
          } catch (error) {
            await this.handleUploadFailure(job, error);
            return;
          }
        }
        if (job.status === "ASSIGNED" || job.status === "UPLOADING") {
          job = this.jobs.transition(job.id, "SUBMITTING", { submitStartedAt: Date.now() });
        }
        const nodes = buildNodeInfoList(job.profileSnapshot, job.parameters, job.media);
        let taskId: string;
        try {
          taskId = await client.runWorkflow(job.runningHubWorkflowId, nodes);
        } catch (error) {
          await this.handleSubmitFailure(job, error);
          return;
        }
        job = this.jobs.transition(job.id, "REMOTE_QUEUED", { remoteTaskId: taskId });
      } else if (job.status === "RETRY_WAIT") {
        job = this.jobs.transition(job.id, "RUNNING", {
          lastError: null, retryPhase: null, retryAfter: null,
        });
      }

      const result = await client.pollTask(job.remoteTaskId!, {
        signal,
        onStatus: async status => {
          const current = this.jobs.get(jobId);
          if (!current) return;
          if (status === "RUNNING" && current.status === "REMOTE_QUEUED") {
            this.jobs.transition(jobId, "RUNNING", {
              generationStartedAt: current.generationStartedAt ?? Date.now(), lastError: null,
            });
          } else if (status === "RUNNING" && current.status === "RUNNING" && !current.generationStartedAt) {
            this.jobs.transition(jobId, "RUNNING", { generationStartedAt: Date.now(), lastError: null });
          } else if ((status === "CREATE" || status === "QUEUED") && current.status === "RUNNING") {
            this.jobs.transition(jobId, "REMOTE_QUEUED");
          }
        },
      });
      const current = this.jobs.get(jobId)!;
      job = this.jobs.transition(jobId, "REMOTE_SUCCESS", {
        outputs: result, rawResult: result.raw, remoteCompletedAt: Date.now(), lastError: null,
      });
      this.accounts.release(job.accountId!, job.id, true, "IDLE");
      job = this.jobs.transition(job.id, "DOWNLOAD_PENDING");
      this.downloads.enqueue(job.id);
      this.logger.info("Remote task succeeded; account released before download", {
        ...context, remoteTaskId: job.remoteTaskId, phase: "REMOTE_SUCCESS",
      });
      void current;
    } catch (error) {
      await this.handlePostSubmitFailure(this.jobs.get(jobId) ?? job, error);
    }
  }

  private async handleSubmitFailure(job: Job, error: unknown): Promise<void> {
    const detail = error instanceof RunningHubError ? error.detail : submitUnknown(error);
    if (detail.accountRelated && detail.safeToReassign) {
      const accountState: AccountState = detail.code === "ACCOUNT_INVALID_KEY" ? "INVALID_KEY"
        : detail.code === "ACCOUNT_NO_BALANCE" ? "NO_BALANCE"
        : detail.code === "RATE_LIMIT" ? "COOLDOWN" : "REMOTE_BUSY";
      const autoDisable = detail.code === "ACCOUNT_INVALID_KEY" || detail.code === "ACCOUNT_NO_BALANCE";
      this.db.updateAccount(job.accountId!, {
        state: accountState, currentJobId: null, autoDisabled: autoDisable,
        autoDisabledReason: autoDisable ? detail.code.toLowerCase() : null,
        cooldownUntil: detail.code === "RATE_LIMIT" ? Date.now() + this.config.accountCooldownMs : null,
        lastErrorAt: Date.now(),
      });
      const requeued = this.jobs.transition(job.id, "PENDING", {
        accountId: null, lastError: detail, assignedAt: null, submitStartedAt: null,
      });
      this.events.emit("account.updated", this.db.getAccount(job.accountId!)!);
      this.logger.warn("Pre-task account failure; job returned to global queue", {
        jobId: requeued.id, accountId: job.accountId, phase: "SUBMITTING",
      }, detail);
      return;
    }
    if (["INVALID_PARAMETER", "WORKFLOW_VALIDATION", "MEDIA_INVALID"].includes(detail.code)) {
      this.jobs.transition(job.id, "FAILED", { lastError: detail, completedAt: Date.now() });
      this.accounts.release(job.accountId!, job.id, false, "IDLE");
      return;
    }
    if (detail.confirmedSubmitFailure) {
      this.jobs.transition(job.id, "FAILED", { lastError: detail, completedAt: Date.now() });
      this.accounts.release(job.accountId!, job.id, false, "IDLE");
      return;
    }
    const unknown = detail.code === "SUBMIT_UNKNOWN" ? detail : submitUnknown(error);
    this.jobs.transition(job.id, "SUBMIT_UNKNOWN", { lastError: unknown, completedAt: Date.now() });
    // Keep the account BUSY: a remote task may exist and must not overlap with a new task.
    this.logger.error("Submit outcome is unknown; automatic resubmission is forbidden", {
      jobId: job.id, accountId: job.accountId, phase: "SUBMITTING",
    }, unknown);
  }

  private async handleUploadFailure(job: Job, error: unknown): Promise<void> {
    const detail: JobError = error instanceof RunningHubError
      ? error.detail
      : { code: "UPLOAD_FAILED", message: String(error), phase: "upload", retryable: true,
          accountRelated: false, safeToReassign: true };
    if (detail.retryable || (detail.accountRelated && detail.safeToReassign)) {
      const accountState: AccountState = detail.code === "ACCOUNT_INVALID_KEY" ? "INVALID_KEY"
        : detail.code === "ACCOUNT_NO_BALANCE" ? "NO_BALANCE" : "TEMP_UNAVAILABLE";
      const autoDisable = detail.code === "ACCOUNT_INVALID_KEY" || detail.code === "ACCOUNT_NO_BALANCE";
      this.db.updateAccount(job.accountId!, {
        state: accountState, currentJobId: null, autoDisabled: autoDisable,
        autoDisabledReason: autoDisable ? detail.code.toLowerCase() : null, lastErrorAt: Date.now(),
      });
      this.jobs.transition(job.id, "PENDING", { accountId: null, lastError: detail, assignedAt: null });
      this.events.emit("account.updated", this.db.getAccount(job.accountId!)!);
      return;
    }
    this.jobs.transition(job.id, "FAILED", { lastError: detail, completedAt: Date.now() });
    this.accounts.release(job.accountId!, job.id, false, "IDLE");
  }

  private async handlePostSubmitFailure(job: Job, error: unknown): Promise<void> {
    if (["CANCELLED", "FAILED", "REMOTE_SUCCESS", "DOWNLOAD_PENDING", "DOWNLOADING", "COMPLETED"]
      .includes(this.jobs.get(job.id)?.status ?? "")) return;
    const detail: JobError = error instanceof RunningHubError
      ? error.detail
      : { code: "QUERY_FAILED", message: String(error), phase: "query", retryable: true,
          accountRelated: false, safeToReassign: false };
    if (detail.code === "CANCEL_FAILED" && ["CANCEL", "CANCELLED"].includes(normalizeRunningHubResponse(detail.raw).status ?? "")) {
      this.stopLocalTracking(job.id);
      this.jobs.transition(job.id, "CANCELLED", { lastError: null, completedAt: Date.now() });
      if (job.accountId) this.accounts.release(job.accountId, job.id, false, "IDLE");
      return;
    }
    if (job.remoteTaskId && !this.running) {
      this.logger.info("Polling stopped; persisted task affinity will be recovered on next start", {
        jobId: job.id, accountId: job.accountId, remoteTaskId: job.remoteTaskId, phase: "STOP",
      });
      return;
    }
    if (job.remoteTaskId && detail.retryable && this.running) {
      const current = this.jobs.get(job.id)!;
      if (current.status === "RUNNING" || current.status === "REMOTE_QUEUED") {
        this.jobs.transition(job.id, "RETRY_WAIT", {
          lastError: detail, retryPhase: "query", retryAfter: Date.now() + this.config.retryDelayMs,
        });
      }
      this.queueQueryRetry(job.id, this.config.retryDelayMs);
      return;
    }
    const current = this.jobs.get(job.id)!;
    if (!["FAILED", "SUBMIT_UNKNOWN", "COMPLETED"].includes(current.status)) {
      this.jobs.transition(job.id, "FAILED", { lastError: detail, completedAt: Date.now() });
    }
    const state: AccountState = detail.code === "ACCOUNT_NO_BALANCE" ? "NO_BALANCE"
      : detail.code === "ACCOUNT_INVALID_KEY" ? "INVALID_KEY" : "IDLE";
    this.accounts.release(job.accountId!, job.id, false, state);
  }

  private queueQueryRetry(jobId: string, delayMs: number): void {
    if (this.retryTimers.has(jobId)) return;
    const timer = setTimeout(() => {
      this.retryTimers.delete(jobId);
      if (this.running) this.launch(jobId);
    }, delayMs);
    timer.unref?.();
    this.retryTimers.set(jobId, timer);
  }

  private stopLocalTracking(jobId: string): void {
    const timer = this.retryTimers.get(jobId);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(jobId);
    this.controllers.get(jobId)?.abort(new Error("Remote task reconciled"));
  }

  private queueAccountWake(delayMs: number): void {
    if (!this.running) return;
    const wakeAt = Date.now() + delayMs;
    // Keep the earliest requested wake-up. A newly rate-limited account may
    // become eligible before a stale-account refresh that was already queued.
    if (this.accountWakeTimer && this.accountWakeAt !== undefined && this.accountWakeAt <= wakeAt) return;
    if (this.accountWakeTimer) clearTimeout(this.accountWakeTimer);
    this.accountWakeAt = wakeAt;
    this.accountWakeTimer = setTimeout(() => {
      this.accountWakeTimer = undefined;
      this.accountWakeAt = undefined;
      if (this.running) void this.schedule();
    }, delayMs);
    this.accountWakeTimer.unref?.();
  }

  private async recoverJobs(): Promise<void> {
    for (let job of this.jobs.list()) {
      if (job.status === "CANCELLED" && hasConfirmedRemoteSuccess(job)) {
        job = this.jobs.recoverTransition(job.id, "REMOTE_SUCCESS", {
          lastError: null, remoteCompletedAt: job.remoteCompletedAt ?? job.completedAt ?? Date.now(), completedAt: null,
        });
      }
      if (["COMPLETED", "FAILED", "CANCELLED", "SUBMIT_UNKNOWN"].includes(job.status)) continue;
      const recoveryError = await this.validateRecovery(job);
      if (recoveryError) {
        if (job.accountId) this.accounts.release(job.accountId, job.id, false, "IDLE");
        this.jobs.recoverTransition(job.id, "FAILED", { lastError: recoveryError, completedAt: Date.now() });
        continue;
      }
      if (job.status === "ASSIGNED" || job.status === "UPLOADING") {
        if (job.accountId) this.accounts.release(job.accountId, job.id, false, "IDLE");
        this.jobs.recoverTransition(job.id, "PENDING", { accountId: null, assignedAt: null });
      } else if (job.status === "SUBMITTING") {
        this.jobs.recoverTransition(job.id, "SUBMIT_UNKNOWN", {
          lastError: submitUnknown(new Error("Process stopped during submit")), completedAt: Date.now(),
        });
      } else if ((job.status === "REMOTE_QUEUED" || job.status === "RUNNING" ||
        (job.status === "RETRY_WAIT" && job.retryPhase === "query")) && job.remoteTaskId && job.accountId) {
        this.db.updateAccount(job.accountId, { state: "BUSY", currentJobId: job.id });
        this.launch(job.id);
      } else if (job.status === "REMOTE_SUCCESS") {
        if (job.accountId) this.accounts.release(job.accountId, job.id, true, "IDLE");
        this.jobs.recoverTransition(job.id, "DOWNLOAD_PENDING");
        this.downloads.enqueue(job.id);
      } else if (job.status === "DOWNLOADING" ||
        (job.status === "RETRY_WAIT" && job.retryPhase === "download")) {
        this.jobs.recoverTransition(job.id, "DOWNLOAD_PENDING", { retryAfter: null });
        this.downloads.enqueue(job.id);
      } else if (job.status === "DOWNLOAD_PENDING") {
        this.downloads.enqueue(job.id);
      }
    }
  }

  private async validateRecovery(job: Job): Promise<JobError | undefined> {
    const fail = (code: JobError["code"], message: string): JobError => ({
      code, message, phase: "recovery", retryable: false, accountRelated: false, safeToReassign: false,
    });
    if (!this.db.getWorkflow(job.workflowId)) return fail("WORKFLOW_VALIDATION", "Recovery blocked: workflow no longer exists.");
    if (!job.profileSnapshot || !Array.isArray(job.profileSnapshot.parameters) ||
      job.profileSnapshot.parameters.some(parameter => !parameter.id || !parameter.nodeId || !parameter.fieldName)) {
      return fail("WORKFLOW_VALIDATION", "Recovery blocked: profile snapshot is incomplete.");
    }
    const inputIds = new Set(job.profileSnapshot.parameters.map(parameter => parameter.id));
    if (Object.keys(job.parameters).some(id => !inputIds.has(id)) || job.media.some(item => !inputIds.has(item.parameterId))) {
      return fail("WORKFLOW_VALIDATION", "Recovery blocked: job snapshot contains parameters outside its profile.");
    }
    if (!job.remoteTaskId) {
      for (const item of job.media) {
        if (item.uploadedValue) continue;
        const info = await stat(item.localPath).catch(() => undefined);
        if (!info?.isFile()) return fail("MEDIA_INVALID", `Recovery blocked: media file is missing: ${item.localPath}`);
      }
    }
    const requiresAccount = !["REMOTE_SUCCESS", "DOWNLOAD_PENDING", "DOWNLOADING"].includes(job.status) &&
      !(job.status === "RETRY_WAIT" && job.retryPhase === "download");
    if (job.accountId && requiresAccount) {
      const account = this.db.getAccount(job.accountId);
      if (!account) return fail("WORKFLOW_VALIDATION", "Recovery blocked: assigned account no longer exists.");
      if (!account.enabled && job.remoteTaskId) return fail("WORKFLOW_VALIDATION", "Recovery blocked: assigned account is disabled.");
    }
    return undefined;
  }
}

function hasConfirmedRemoteSuccess(job: Job): boolean {
  if (!job.remoteTaskId || !job.outputs?.files.length) return false;
  const normalized = normalizeRunningHubResponse(job.rawResult ?? job.outputs.raw);
  return normalized.status === "SUCCESS";
}

function isApiKeyCancelNotAllowed(error: unknown): boolean {
  if (error instanceof RunningHubError && error.detail.remoteCode === "APIKEY_TASK_CANCEL_NOT_ALLOWED") return true;
  const text = error instanceof Error ? error.message : String(error);
  return /APIKEY_TASK_CANCEL_NOT_ALLOWED/i.test(text);
}

function isRemoteTaskMissing(error: unknown): boolean {
  if (error instanceof RunningHubError) {
    return error.detail.remoteCode === "1004" ||
      (error.detail.code === "TASK_FAILED" && /不存在|已过期|task not found/i.test(error.detail.message));
  }
  return /(?:1004|task not found|任务不存在|任务已过期)/i.test(error instanceof Error ? error.message : String(error));
}

async function readFileWithHash(filePath: string): Promise<{ hash: string; size: number }> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error(`File does not exist: ${filePath}`);
    const hash = createHash("sha256");
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(filePath);
      stream.on("data", chunk => hash.update(chunk));
      stream.once("end", resolve);
      stream.once("error", reject);
    });
    return { hash: hash.digest("hex"), size: info.size };
  } catch (error) {
    const detail: JobError = {
      code: "MEDIA_INVALID", message: `无法读取本地媒体文件：${filePath}`,
      phase: "upload", retryable: false, accountRelated: false, safeToReassign: false,
      raw: error instanceof Error ? { name: error.name, message: error.message } : String(error),
    };
    throw new RunningHubError(detail.message, detail, error);
  }
}
