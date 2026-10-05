import type { CoreDatabase } from "../database.js";
import { randomUUID } from "node:crypto";
import type { BackendEvents } from "../events.js";
import type { CreateJobInput, Job, JobStatus } from "../types.js";
import { validateProfile, validateProfileAgainstWorkflow } from "../workflows/profiles.js";
import { sharpInputs } from "../gemini/h3Optimizer.js";

const TRANSITIONS: Record<JobStatus, ReadonlySet<JobStatus>> = {
  OPTIMIZE_PENDING: new Set(["OPTIMIZING", "CANCELLED", "FAILED"]),
  OPTIMIZING: new Set(["OPTIMIZE_PENDING", "PENDING", "CANCELLED", "FAILED"]),
  PENDING: new Set(["ASSIGNED", "CANCELLED"]),
  ASSIGNED: new Set(["UPLOADING", "SUBMITTING", "PENDING", "FAILED", "CANCELLED"]),
  UPLOADING: new Set(["SUBMITTING", "PENDING", "RETRY_WAIT", "FAILED", "CANCELLED"]),
  SUBMITTING: new Set(["REMOTE_QUEUED", "RUNNING", "SUBMIT_UNKNOWN", "PENDING", "FAILED", "CANCELLED"]),
  SUBMIT_UNKNOWN: new Set([]),
  REMOTE_QUEUED: new Set(["RUNNING", "REMOTE_SUCCESS", "RETRY_WAIT", "FAILED", "CANCELLED"]),
  RUNNING: new Set(["REMOTE_QUEUED", "REMOTE_SUCCESS", "RETRY_WAIT", "FAILED", "CANCELLED"]),
  // Once RunningHub has returned SUCCESS, "stop generation" is no longer a
  // valid operation.  Keeping CANCELLED out of these transitions prevents a
  // late cancel response from overwriting a successful result while it is
  // being queued or downloaded.
  REMOTE_SUCCESS: new Set(["DOWNLOAD_PENDING"]),
  DOWNLOAD_PENDING: new Set(["DOWNLOADING", "RETRY_WAIT", "FAILED", "CANCELLED"]),
  DOWNLOADING: new Set(["COMPLETED", "DOWNLOAD_PENDING", "RETRY_WAIT", "FAILED", "CANCELLED"]),
  COMPLETED: new Set([]),
  FAILED: new Set([]),
  RETRY_WAIT: new Set(["REMOTE_QUEUED", "RUNNING", "REMOTE_SUCCESS", "DOWNLOAD_PENDING", "PENDING", "FAILED", "CANCELLED"]),
  CANCELLED: new Set([]),
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return TRANSITIONS[from].has(to);
}

export class Jobs {
  constructor(private readonly db: CoreDatabase, private readonly events: BackendEvents) {}

  create(input: CreateJobInput): Job {
    const job = this.insert(input.production ? { ...input, production: { ...input.production, groupId: randomUUID() } } : input);
    this.emit(job);
    return job;
  }

  createBatch(inputs: CreateJobInput[]): Job[] {
    if (!inputs.length || inputs.length > 500) throw new Error("批次任务数量必须为 1–500。");
    const groups = new Map<string, string>();
    const segments = new Set<string>();
    inputs = inputs.map(input => {
      if (!input.production) return input;
      const key = input.production.groupId;
      const segmentKey = `${key}:${input.production.segmentIndex}`;
      if (segments.has(segmentKey)) throw new Error("同一制作组的段号重复，请重新加入制作批次");
      segments.add(segmentKey);
      if (typeof key !== "string" || !key.length || key.length > 100) throw new Error("制作批次标识无效");
      if (!groups.has(key)) groups.set(key, randomUUID());
      return { ...input, production: { ...input.production, groupId: groups.get(key)! } };
    });
    const jobs = this.db.transaction(() => inputs.map((input, index) => {
      try { return this.insert(input); }
      catch (error) {
        throw new Error(`批次第 ${index + 1} 项创建失败，整批未提交：${error instanceof Error ? error.message : "数据写入失败"}`);
      }
    }));
    // Publish only after commit. Notification failure must not turn a committed
    // batch into a rejected request, which would invite duplicate submissions.
    for (const job of jobs) {
      try { this.events.emit("job.updated", job); }
      catch { console.error("Batch committed; job notification failed", job.id); }
    }
    try { this.events.emit("queue.updated", this.db.pendingCount()); }
    catch { console.error("Batch committed; queue notification failed"); }
    return jobs;
  }

  private insert(input: CreateJobInput): Job {
    if (input.production && (!Number.isInteger(input.production.segmentIndex) || input.production.segmentIndex < 1 || input.production.segmentIndex > 9999)) throw new Error("段落编号无效");
    const workflow = this.db.getWorkflow(input.workflowId);
    if (!workflow) throw new Error(`Workflow not found: ${input.workflowId}`);
    if (input.promptOptimization) {
      if (!/^gemini-[A-Za-z0-9._-]{1,100}$/.test(input.promptOptimization.model)) throw new Error("优化模型无效");
      sharpInputs(workflow, input);
    }
    // Recheck persisted profiles too: older imports predate current validation.
    validateProfile(workflow.profile);
    validateProfileAgainstWorkflow(workflow.profile, workflow.raw);
    const validIds = new Set(workflow.profile.parameters.map(parameter => parameter.id));
    for (const key of Object.keys(input.parameters)) {
      if (!validIds.has(key)) throw new Error(`Unknown workflow parameter: ${key}`);
    }
    const job = this.db.createJob(input, workflow);
    return job;
  }

  list(statuses?: JobStatus[]): Job[] { return this.db.listJobs(statuses); }
  get(id: string): Job | undefined { return this.db.getJob(id); }

  transition(id: string, to: JobStatus, update: Parameters<CoreDatabase["updateJob"]>[1] = {}): Job {
    const current = this.db.getJob(id);
    if (!current) throw new Error(`Job not found: ${id}`);
    if (current.status !== to && !canTransition(current.status, to)) {
      throw new Error(`Illegal job transition: ${current.status} -> ${to}`);
    }
    const job = this.db.updateJob(id, { ...update, status: to,
      ...(["CANCELLED", "FAILED", "REMOTE_SUCCESS", "COMPLETED"].includes(to) ? { cancelRequestedAt: null } : {}) });
    this.emit(job);
    return job;
  }

  /** Recovery-only state restoration after validating persisted invariants. */
  recoverTransition(id: string, to: JobStatus, update: Parameters<CoreDatabase["updateJob"]>[1] = {}): Job {
    const job = this.db.updateJob(id, { ...update, status: to });
    this.emit(job);
    return job;
  }

  cancel(id: string): Job { return this.transition(id, "CANCELLED", { completedAt: Date.now() }); }

  remove(id: string): boolean {
    const job = this.db.getJob(id);
    if (!job) return false;
    if (!["COMPLETED", "FAILED", "SUBMIT_UNKNOWN", "CANCELLED"].includes(job.status)) {
      throw new Error("执行中或等待中的任务不能直接删除，请先停止任务跟踪。 ");
    }
    if (job.accountId) {
      const released = this.db.releaseAccount(job.accountId, job.id, false, job.status === "SUBMIT_UNKNOWN" ? "REMOTE_BUSY" : "IDLE");
      if (released) this.events.emit("account.updated", released);
    }
    const removed = this.db.removeJob(id);
    if (removed) this.events.emit("queue.updated", this.db.pendingCount());
    return removed;
  }

  retryDownload(id: string): Job {
    const job = this.db.getJob(id);
    if (!job?.remoteTaskId || !job.outputs?.files.length) throw new Error("Job has no successful remote output to download.");
    if (!["FAILED", "RETRY_WAIT", "COMPLETED"].includes(job.status)) throw new Error("Job is not eligible for download retry.");
    return this.recoverTransition(id, "DOWNLOAD_PENDING", {
      lastError: null, retryPhase: null, retryAfter: null, completedAt: null,
    });
  }

  private emit(job: Job): void {
    this.events.emit("job.updated", job);
    this.events.emit("queue.updated", this.db.pendingCount());
  }
}
