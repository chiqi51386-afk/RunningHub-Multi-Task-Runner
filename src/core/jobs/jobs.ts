import type { CoreDatabase } from "../database.js";
import type { BackendEvents } from "../events.js";
import type { CreateJobInput, Job, JobStatus } from "../types.js";

const TRANSITIONS: Record<JobStatus, ReadonlySet<JobStatus>> = {
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
    const workflow = this.db.getWorkflow(input.workflowId);
    if (!workflow) throw new Error(`Workflow not found: ${input.workflowId}`);
    const validIds = new Set(workflow.profile.parameters.map(parameter => parameter.id));
    for (const key of Object.keys(input.parameters)) {
      if (!validIds.has(key)) throw new Error(`Unknown workflow parameter: ${key}`);
    }
    const job = this.db.createJob(input, workflow);
    this.emit(job);
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
    const job = this.db.updateJob(id, { ...update, status: to });
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
