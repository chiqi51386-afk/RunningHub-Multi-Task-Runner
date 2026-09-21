import { randomUUID, createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import type { Database as BetterDatabase } from "better-sqlite3";
import type { SecretStore } from "./secretStore.js";
import type {
  Account,
  AccountState,
  AccountWithSecret,
  CreateJobInput,
  Job,
  JobError,
  JobPhase,
  JobResult,
  JobStatus,
  MediaUploadCacheEntry,
  WorkflowProfile,
  WorkflowRecord,
} from "./types.js";

type DbRow = Record<string, unknown>;

const ACCOUNT_SELECT = `
  SELECT id, label, encrypted_key, enabled, manual_disabled, auto_disabled,
         auto_disabled_reason, state, current_job_id, balance, coins,
         remote_task_count, api_type, cooldown_until, last_checked_at,
         last_used_at, last_success_at, last_error_at, created_at, updated_at
  FROM accounts`;

const JOB_SELECT = `
  SELECT id, workflow_id, runninghub_workflow_id, workflow_name, profile_version,
         profile_snapshot_json, parameters_json, media_json, output_dir, account_id,
         remote_task_id, status, outputs_json, raw_result_json, error_json,
         retry_phase, retry_after, created_at, assigned_at, submit_started_at,
         remote_completed_at, completed_at, updated_at
  FROM jobs`;

export class CoreDatabase {
  readonly raw: BetterDatabase;

  constructor(filename: string, private readonly secretStore: SecretStore) {
    if (filename !== ":memory:") mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
    this.raw = new BetterSqlite3(filename);
    this.raw.pragma("journal_mode = WAL");
    this.raw.pragma("busy_timeout = 5000");
    this.raw.pragma("foreign_keys = ON");
    this.migrate();
  }

  close(): void { this.raw.close(); }

  transaction<T>(fn: () => T): T {
    return this.raw.transaction(fn)();
  }

  private migrate(): void {
    this.raw.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        key_fingerprint TEXT NOT NULL UNIQUE,
        encrypted_key BLOB NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        manual_disabled INTEGER NOT NULL DEFAULT 0,
        auto_disabled INTEGER NOT NULL DEFAULT 0,
        auto_disabled_reason TEXT,
        state TEXT NOT NULL,
        current_job_id TEXT,
        balance TEXT,
        coins TEXT,
        remote_task_count INTEGER,
        api_type TEXT,
        cooldown_until INTEGER,
        last_checked_at INTEGER,
        last_used_at INTEGER,
        last_success_at INTEGER,
        last_error_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        runninghub_workflow_id TEXT NOT NULL,
        source_url TEXT,
        raw_json TEXT NOT NULL,
        profile_json TEXT NOT NULL,
        profile_version INTEGER NOT NULL,
        workflow_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        runninghub_workflow_id TEXT NOT NULL,
        workflow_name TEXT,
        profile_version INTEGER NOT NULL,
        profile_snapshot_json TEXT NOT NULL,
        parameters_json TEXT NOT NULL,
        media_json TEXT NOT NULL,
        output_dir TEXT,
        account_id TEXT,
        remote_task_id TEXT,
        status TEXT NOT NULL,
        outputs_json TEXT,
        raw_result_json TEXT,
        error_json TEXT,
        retry_phase TEXT,
        retry_after INTEGER,
        created_at INTEGER NOT NULL,
        assigned_at INTEGER,
        submit_started_at INTEGER,
        remote_completed_at INTEGER,
        completed_at INTEGER,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(workflow_id) REFERENCES workflows(id) ON DELETE RESTRICT,
        FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS media_upload_cache (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        file_hash TEXT NOT NULL,
        file_size INTEGER,
        original_path TEXT,
        runninghub_value TEXT NOT NULL,
        uploaded_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL,
        UNIQUE(account_id, file_hash),
        FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_jobs_remote_task ON jobs(remote_task_id);
      CREATE INDEX IF NOT EXISTS idx_jobs_account ON jobs(account_id);
      CREATE INDEX IF NOT EXISTS idx_accounts_state ON accounts(state, enabled);
      CREATE INDEX IF NOT EXISTS idx_media_cache_account_hash ON media_upload_cache(account_id, file_hash);
    `);
    const workflowColumns = this.raw.prepare("PRAGMA table_info(workflows)").all() as DbRow[];
    if (!workflowColumns.some(column => column.name === "deleted_at")) {
      this.raw.exec("ALTER TABLE workflows ADD COLUMN deleted_at INTEGER");
    }
    if (!workflowColumns.some(column => column.name === "source_url")) {
      this.raw.exec("ALTER TABLE workflows ADD COLUMN source_url TEXT");
    }
    this.repairMisclassifiedSubmitErrors();
    this.repairOrphanedAccountClaims();
  }

  private repairMisclassifiedSubmitErrors(): void {
    const rows = this.raw.prepare(`
      SELECT id, account_id, error_json FROM jobs
      WHERE status = 'SUBMIT_UNKNOWN'
        AND (lower(error_json) LIKE '%node_info_mismatch%'
          OR lower(error_json) LIKE '%field_not_found_in_node_inputs%')
    `).all() as DbRow[];
    for (const row of rows) {
      const previous = parseJson(row.error_json, {} as Partial<JobError>);
      const detail: JobError = {
        code: "WORKFLOW_VALIDATION",
        message: String(previous.message ?? "RunningHub workflow node mapping does not match the remote workflow."),
        phase: "submit",
        retryable: false,
        accountRelated: false,
        safeToReassign: false,
        remoteCode: previous.remoteCode ?? "NODE_INFO_MISMATCH",
        raw: previous.raw,
      };
      const now = Date.now();
      this.raw.prepare(`
        UPDATE jobs SET status = 'FAILED', error_json = ?, completed_at = COALESCE(completed_at, ?), updated_at = ?
        WHERE id = ? AND status = 'SUBMIT_UNKNOWN'
      `).run(json(detail), now, now, row.id);
      if (row.account_id) {
        this.raw.prepare(`
          UPDATE accounts SET state = 'IDLE', current_job_id = NULL, updated_at = ?
          WHERE id = ? AND current_job_id = ?
        `).run(now, row.account_id, row.id);
      }
    }
  }

  private repairOrphanedAccountClaims(): void {
    const now = Date.now();
    this.raw.prepare(`
      UPDATE accounts
      SET current_job_id = NULL,
          state = CASE WHEN enabled = 1 AND manual_disabled = 0 THEN 'IDLE' ELSE 'DISABLED' END,
          updated_at = ?
      WHERE current_job_id IS NOT NULL
        AND (
          NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.id = accounts.current_job_id)
          OR EXISTS (
            SELECT 1 FROM jobs
            WHERE jobs.id = accounts.current_job_id
              AND jobs.status IN ('COMPLETED', 'FAILED', 'CANCELLED')
          )
        )
    `).run(now);
  }

  addAccount(label: string, apiKey: string): Account {
    const clean = apiKey.trim();
    if (!clean) throw new Error("API key is required.");
    const id = randomUUID();
    const now = Date.now();
    const encrypted = this.secretStore.encrypt(clean);
    const fingerprint = createHash("sha256").update(clean).digest("hex").slice(0, 32);
    try {
      this.raw.prepare(`
        INSERT INTO accounts (
          id, label, key_fingerprint, encrypted_key, enabled, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 1, 'UNCHECKED', ?, ?)
      `).run(id, label.trim() || "RunningHub Account", fingerprint, encrypted, now, now);
    } catch (error) {
      if (String(error).includes("UNIQUE")) throw new Error("该 API Key 已存在，已阻止重复添加。");
      throw error;
    }
    return this.getAccount(id)!;
  }

  getAccount(id: string): Account | undefined {
    const row = this.raw.prepare(`${ACCOUNT_SELECT} WHERE id = ?`).get(id) as DbRow | undefined;
    return row ? accountFromRow(row) : undefined;
  }

  getAccountWithSecret(id: string): AccountWithSecret | undefined {
    const row = this.raw.prepare(`${ACCOUNT_SELECT} WHERE id = ?`).get(id) as DbRow | undefined;
    if (!row) return undefined;
    const encrypted = row.encrypted_key;
    if (typeof encrypted !== "string" && !Buffer.isBuffer(encrypted)) throw new Error("Invalid encrypted key storage.");
    return { ...accountFromRow(row), apiKey: this.secretStore.decrypt(encrypted) };
  }

  updateAccountKey(id: string, apiKey: string): Account {
    const clean = apiKey.trim();
    if (!clean) throw new Error("API Key 不能为空。");
    if (!this.getAccount(id)) throw new Error(`Account not found: ${id}`);
    const encrypted = this.secretStore.encrypt(clean);
    const fingerprint = createHash("sha256").update(clean).digest("hex").slice(0, 32);
    try {
      this.raw.prepare(`
        UPDATE accounts
        SET key_fingerprint = ?, encrypted_key = ?, state = 'UNCHECKED',
            auto_disabled = 0, auto_disabled_reason = NULL, last_error_at = NULL, updated_at = ?
        WHERE id = ?
      `).run(fingerprint, encrypted, Date.now(), id);
    } catch (error) {
      if (String(error).includes("UNIQUE")) throw new Error("该 API Key 已被其他账号使用。");
      throw error;
    }
    return this.getAccount(id)!;
  }

  listAccounts(): Account[] {
    return (this.raw.prepare(`${ACCOUNT_SELECT} ORDER BY created_at ASC`).all() as DbRow[]).map(accountFromRow);
  }

  removeAccount(id: string): boolean {
    const account = this.getAccount(id);
    if (account?.currentJobId) throw new Error("Cannot remove an account with an active job.");
    return this.raw.prepare("DELETE FROM accounts WHERE id = ?").run(id).changes > 0;
  }

  setAccountEnabled(id: string, enabled: boolean): Account {
    const now = Date.now();
    this.raw.prepare(`
      UPDATE accounts
      SET enabled = ?, manual_disabled = ?,
          auto_disabled = CASE WHEN ? = 1 THEN 0 ELSE auto_disabled END,
          auto_disabled_reason = CASE WHEN ? = 1 THEN NULL ELSE auto_disabled_reason END,
          state = CASE WHEN ? = 1 THEN 'CHECKING' ELSE 'DISABLED' END,
          updated_at = ?
      WHERE id = ?
    `).run(Number(enabled), Number(!enabled), Number(enabled), Number(enabled), Number(enabled), now, id);
    const account = this.getAccount(id);
    if (!account) throw new Error(`Account not found: ${id}`);
    return account;
  }

  updateAccount(id: string, update: Partial<{
    state: AccountState;
    currentJobId: string | null;
    balance: string | null;
    coins: string | null;
    remoteTaskCount: number | null;
    apiType: string | null;
    cooldownUntil: number | null;
    lastCheckedAt: number | null;
    lastUsedAt: number | null;
    lastSuccessAt: number | null;
    lastErrorAt: number | null;
    autoDisabled: boolean;
    autoDisabledReason: string | null;
  }>): Account {
    const mapping: Record<string, string> = {
      state: "state", currentJobId: "current_job_id", balance: "balance", coins: "coins",
      remoteTaskCount: "remote_task_count", apiType: "api_type", cooldownUntil: "cooldown_until",
      lastCheckedAt: "last_checked_at", lastUsedAt: "last_used_at", lastSuccessAt: "last_success_at",
      lastErrorAt: "last_error_at", autoDisabled: "auto_disabled", autoDisabledReason: "auto_disabled_reason",
    };
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(mapping)) {
      if (!Object.prototype.hasOwnProperty.call(update, key)) continue;
      sets.push(`${column} = ?`);
      const value = update[key as keyof typeof update];
      values.push(typeof value === "boolean" ? Number(value) : value);
    }
    if (sets.length === 0) return this.getAccount(id)!;
    sets.push("updated_at = ?");
    values.push(Date.now(), id);
    this.raw.prepare(`UPDATE accounts SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    const account = this.getAccount(id);
    if (!account) throw new Error(`Account not found: ${id}`);
    return account;
  }

  listAvailableAccounts(now = Date.now()): Account[] {
    return (this.raw.prepare(`
      ${ACCOUNT_SELECT}
      WHERE enabled = 1 AND manual_disabled = 0 AND auto_disabled = 0
        AND state = 'IDLE' AND current_job_id IS NULL
        AND (cooldown_until IS NULL OR cooldown_until <= ?)
      ORDER BY COALESCE(last_used_at, 0) ASC, created_at ASC
    `).all(now) as DbRow[]).map(accountFromRow);
  }

  saveWorkflow(workflow: WorkflowRecord): void {
    this.raw.prepare(`
      INSERT INTO workflows (
        id, name, runninghub_workflow_id, source_url, raw_json, profile_json, profile_version,
        workflow_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        runninghub_workflow_id = excluded.runninghub_workflow_id,
        source_url = excluded.source_url,
        raw_json = excluded.raw_json,
        profile_json = excluded.profile_json,
        profile_version = excluded.profile_version,
        workflow_hash = excluded.workflow_hash,
        deleted_at = NULL,
        updated_at = excluded.updated_at
    `).run(
      workflow.id, workflow.name, workflow.runningHubWorkflowId, workflow.sourceUrl ?? null, json(workflow.raw), json(workflow.profile),
      workflow.profileVersion, workflow.workflowHash, workflow.createdAt, workflow.updatedAt,
    );
  }

  findWorkflowByHash(workflowHash: string): WorkflowRecord | undefined {
    const row = this.raw.prepare("SELECT * FROM workflows WHERE workflow_hash = ? AND deleted_at IS NULL ORDER BY created_at ASC LIMIT 1")
      .get(workflowHash) as DbRow | undefined;
    return row ? workflowFromRow(row) : undefined;
  }

  getWorkflow(id: string): WorkflowRecord | undefined {
    const row = this.raw.prepare("SELECT * FROM workflows WHERE id = ?").get(id) as DbRow | undefined;
    return row ? workflowFromRow(row) : undefined;
  }

  listWorkflows(): WorkflowRecord[] {
    return (this.raw.prepare("SELECT * FROM workflows WHERE deleted_at IS NULL ORDER BY created_at ASC").all() as DbRow[]).map(workflowFromRow);
  }

  removeWorkflow(id: string): boolean {
    return this.transaction(() => {
      const referenced = Number((this.raw.prepare("SELECT COUNT(*) AS count FROM jobs WHERE workflow_id = ?").get(id) as DbRow | undefined)?.count ?? 0);
      if (referenced === 0) return this.raw.prepare("DELETE FROM workflows WHERE id = ?").run(id).changes > 0;
      return this.raw.prepare("UPDATE workflows SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
        .run(Date.now(), Date.now(), id).changes > 0;
    });
  }

  createJob(input: CreateJobInput, workflow: WorkflowRecord): Job {
    const now = Date.now();
    const id = randomUUID();
    const profileSnapshot = structuredClone(workflow.profile);
    this.raw.prepare(`
      INSERT INTO jobs (
        id, workflow_id, runninghub_workflow_id, workflow_name, profile_version,
        profile_snapshot_json, parameters_json, media_json, output_dir, status,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)
    `).run(
      id, workflow.id, workflow.runningHubWorkflowId, workflow.name, workflow.profileVersion,
      json(profileSnapshot), json(structuredClone(input.parameters)), json(structuredClone(input.media ?? [])),
      input.outputDir ?? null, now, now,
    );
    return this.getJob(id)!;
  }

  getJob(id: string): Job | undefined {
    const row = this.raw.prepare(`${JOB_SELECT} WHERE id = ?`).get(id) as DbRow | undefined;
    return row ? jobFromRow(row) : undefined;
  }

  removeJob(id: string): boolean {
    return this.raw.prepare("DELETE FROM jobs WHERE id = ?").run(id).changes > 0;
  }

  listJobs(statuses?: JobStatus[]): Job[] {
    if (!statuses?.length) return (this.raw.prepare(`${JOB_SELECT} ORDER BY created_at DESC`).all() as DbRow[]).map(jobFromRow);
    const placeholders = statuses.map(() => "?").join(",");
    return (this.raw.prepare(`${JOB_SELECT} WHERE status IN (${placeholders}) ORDER BY created_at DESC`).all(...statuses) as DbRow[]).map(jobFromRow);
  }

  pendingCount(): number {
    return Number((this.raw.prepare("SELECT COUNT(*) count FROM jobs WHERE status = 'PENDING'").get() as DbRow).count);
  }

  updateJob(id: string, update: Partial<{
    status: JobStatus;
    accountId: string | null;
    remoteTaskId: string | null;
    media: unknown[];
    outputs: JobResult | null;
    rawResult: unknown;
    lastError: JobError | null;
    retryPhase: JobPhase | null;
    retryAfter: number | null;
    assignedAt: number | null;
    submitStartedAt: number | null;
    remoteCompletedAt: number | null;
    completedAt: number | null;
  }>): Job {
    const mapping: Record<string, { column: string; encode?: (value: unknown) => unknown }> = {
      status: { column: "status" }, accountId: { column: "account_id" }, remoteTaskId: { column: "remote_task_id" },
      media: { column: "media_json", encode: json }, outputs: { column: "outputs_json", encode: nullableJson },
      rawResult: { column: "raw_result_json", encode: nullableJson }, lastError: { column: "error_json", encode: nullableJson },
      retryPhase: { column: "retry_phase" }, retryAfter: { column: "retry_after" }, assignedAt: { column: "assigned_at" },
      submitStartedAt: { column: "submit_started_at" }, remoteCompletedAt: { column: "remote_completed_at" },
      completedAt: { column: "completed_at" },
    };
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, descriptor] of Object.entries(mapping)) {
      if (!Object.prototype.hasOwnProperty.call(update, key)) continue;
      sets.push(`${descriptor.column} = ?`);
      const value = update[key as keyof typeof update];
      values.push(descriptor.encode ? descriptor.encode(value) : value);
    }
    if (!sets.length) return this.getJob(id)!;
    sets.push("updated_at = ?");
    values.push(Date.now(), id);
    this.raw.prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    const job = this.getJob(id);
    if (!job) throw new Error(`Job not found: ${id}`);
    return job;
  }

  claimNextJob(accountId: string, now = Date.now()): Job | undefined {
    return this.transaction(() => {
      const account = this.raw.prepare(`
        SELECT id FROM accounts
        WHERE id = ? AND enabled = 1 AND manual_disabled = 0 AND auto_disabled = 0
          AND state = 'IDLE' AND current_job_id IS NULL
          AND (cooldown_until IS NULL OR cooldown_until <= ?)
      `).get(accountId, now);
      if (!account) return undefined;
      const row = this.raw.prepare(`${JOB_SELECT} WHERE status = 'PENDING' ORDER BY created_at ASC LIMIT 1`).get() as DbRow | undefined;
      if (!row) return undefined;
      const jobId = String(row.id);
      const changed = this.raw.prepare(`
        UPDATE jobs SET status = 'ASSIGNED', account_id = ?, assigned_at = ?, updated_at = ?
        WHERE id = ? AND status = 'PENDING'
      `).run(accountId, now, now, jobId).changes;
      if (changed !== 1) return undefined;
      this.raw.prepare(`
        UPDATE accounts SET state = 'BUSY', current_job_id = ?, last_used_at = ?, updated_at = ?
        WHERE id = ?
      `).run(jobId, now, now, accountId);
      return this.getJob(jobId);
    });
  }

  releaseAccount(accountId: string, jobId: string, successful: boolean, state: AccountState = "IDLE"): Account | undefined {
    const now = Date.now();
    this.raw.prepare(`
      UPDATE accounts SET state = ?, current_job_id = NULL,
        last_success_at = CASE WHEN ? = 1 THEN ? ELSE last_success_at END,
        last_error_at = CASE WHEN ? = 0 THEN ? ELSE last_error_at END,
        updated_at = ? WHERE id = ? AND current_job_id = ?
    `).run(state, Number(successful), now, Number(successful), now, now, accountId, jobId);
    return this.getAccount(accountId);
  }

  getMediaUploadCache(accountId: string, fileHash: string): MediaUploadCacheEntry | undefined {
    const row = this.raw.prepare(`
      SELECT id, account_id, file_hash, file_size, original_path, runninghub_value, uploaded_at, last_used_at
      FROM media_upload_cache WHERE account_id = ? AND file_hash = ?
    `).get(accountId, fileHash) as DbRow | undefined;
    if (!row) return undefined;
    this.raw.prepare("UPDATE media_upload_cache SET last_used_at = ? WHERE id = ?").run(Date.now(), row.id);
    return mediaCacheFromRow({ ...row, last_used_at: Date.now() });
  }

  saveMediaUploadCache(input: Omit<MediaUploadCacheEntry, "id" | "uploadedAt" | "lastUsedAt">): MediaUploadCacheEntry {
    const now = Date.now();
    const id = randomUUID();
    this.raw.prepare(`
      INSERT INTO media_upload_cache (
        id, account_id, file_hash, file_size, original_path, runninghub_value, uploaded_at, last_used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, file_hash) DO UPDATE SET
        file_size = excluded.file_size,
        original_path = excluded.original_path,
        runninghub_value = excluded.runninghub_value,
        last_used_at = excluded.last_used_at
    `).run(id, input.accountId, input.fileHash, input.fileSize ?? null, input.originalPath ?? null, input.runningHubValue, now, now);
    return this.getMediaUploadCache(input.accountId, input.fileHash)!;
  }
}

function json(value: unknown): string { return JSON.stringify(value); }
function nullableJson(value: unknown): string | null { return value == null ? null : JSON.stringify(value); }
function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}
function optionalNumber(value: unknown): number | undefined { return value == null ? undefined : Number(value); }
function optionalString(value: unknown): string | undefined { return value == null ? undefined : String(value); }

function accountFromRow(row: DbRow): Account {
  return {
    id: String(row.id), label: String(row.label), enabled: Boolean(row.enabled),
    manualDisabled: Boolean(row.manual_disabled), autoDisabled: Boolean(row.auto_disabled),
    autoDisabledReason: optionalString(row.auto_disabled_reason), state: String(row.state) as AccountState,
    currentJobId: optionalString(row.current_job_id), balance: optionalString(row.balance), coins: optionalString(row.coins),
    lastRemoteTaskCount: optionalNumber(row.remote_task_count), apiType: optionalString(row.api_type),
    cooldownUntil: optionalNumber(row.cooldown_until), lastCheckedAt: optionalNumber(row.last_checked_at),
    lastUsedAt: optionalNumber(row.last_used_at), lastSuccessAt: optionalNumber(row.last_success_at),
    lastErrorAt: optionalNumber(row.last_error_at), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}

function workflowFromRow(row: DbRow): WorkflowRecord {
  return {
    id: String(row.id), name: String(row.name), runningHubWorkflowId: String(row.runninghub_workflow_id), sourceUrl: optionalString(row.source_url),
    raw: parseJson(String(row.raw_json), {}), profile: parseJson(String(row.profile_json), {} as WorkflowProfile),
    profileVersion: Number(row.profile_version), workflowHash: String(row.workflow_hash),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}

function jobFromRow(row: DbRow): Job {
  return {
    id: String(row.id), workflowId: String(row.workflow_id), runningHubWorkflowId: String(row.runninghub_workflow_id),
    workflowName: String(row.workflow_name ?? ""), profileVersion: Number(row.profile_version),
    profileSnapshot: parseJson(String(row.profile_snapshot_json), {} as WorkflowProfile),
    parameters: parseJson(String(row.parameters_json), {}), media: parseJson(String(row.media_json), []),
    outputDir: optionalString(row.output_dir), accountId: optionalString(row.account_id),
    remoteTaskId: optionalString(row.remote_task_id), status: String(row.status) as JobStatus,
    outputs: parseJson(row.outputs_json, undefined as JobResult | undefined), rawResult: parseJson(row.raw_result_json, undefined),
    lastError: parseJson(row.error_json, undefined as JobError | undefined), retryPhase: optionalString(row.retry_phase) as JobPhase | undefined,
    retryAfter: optionalNumber(row.retry_after), createdAt: Number(row.created_at), assignedAt: optionalNumber(row.assigned_at),
    submitStartedAt: optionalNumber(row.submit_started_at), remoteCompletedAt: optionalNumber(row.remote_completed_at),
    completedAt: optionalNumber(row.completed_at), updatedAt: Number(row.updated_at),
  };
}

function mediaCacheFromRow(row: DbRow): MediaUploadCacheEntry {
  return {
    id: String(row.id), accountId: String(row.account_id), fileHash: String(row.file_hash),
    fileSize: optionalNumber(row.file_size), originalPath: optionalString(row.original_path),
    runningHubValue: String(row.runninghub_value), uploadedAt: Number(row.uploaded_at), lastUsedAt: Number(row.last_used_at),
  };
}
