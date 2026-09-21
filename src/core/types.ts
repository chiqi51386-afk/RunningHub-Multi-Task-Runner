export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface RunningHubConfig {
  apiHost: string;
  pollIntervalMs: number;
  pollJitterMs: number;
  maxPollingMs: number;
  requestTimeoutMs: number;
  uploadTimeoutMs: number;
  downloadTimeoutMs: number;
  maxQueryFailures: number;
  accountFreshnessMs: number;
  maxDownloads: number;
  outputDir: string;
  mediaCacheTtlMs: number;
  retryDelayMs: number;
  accountCooldownMs: number;
}

export interface AccountStatus {
  valid: boolean;
  balance?: string;
  coins?: string;
  currentTaskCount?: number;
  apiType?: string;
  raw: unknown;
}

export type AccountState =
  | "UNCHECKED"
  | "SECRET_UNREADABLE"
  | "IDLE"
  | "BUSY"
  | "REMOTE_BUSY"
  | "CHECKING"
  | "COOLDOWN"
  | "NO_BALANCE"
  | "INVALID_KEY"
  | "TEMP_UNAVAILABLE"
  | "DISABLED";

export interface Account {
  id: string;
  label: string;
  enabled: boolean;
  manualDisabled: boolean;
  autoDisabled: boolean;
  autoDisabledReason?: string;
  state: AccountState;
  currentJobId?: string;
  balance?: string;
  coins?: string;
  lastRemoteTaskCount?: number;
  apiType?: string;
  lastCheckedAt?: number;
  lastUsedAt?: number;
  lastSuccessAt?: number;
  lastErrorAt?: number;
  cooldownUntil?: number;
  createdAt: number;
  updatedAt: number;
}

export interface AccountWithSecret extends Account {
  apiKey: string;
}

export type WorkflowValueType =
  | "string"
  | "integer"
  | "number"
  | "boolean"
  | "image"
  | "video"
  | "audio"
  | "select"
  | "json";

export type WorkflowSemanticType =
  | "prompt"
  | "negative_prompt"
  | "image"
  | "video"
  | "audio"
  | "duration"
  | "fps"
  | "frames"
  | "width"
  | "height"
  | "aspect_ratio"
  | "resolution"
  | "resolution_multiple"
  | "upscale_factor"
  | "seed"
  | "steps"
  | "cfg"
  | "sampler"
  | "scheduler"
  | "denoise"
  | "model"
  | "lora"
  | "unknown";

export interface WorkflowParameter {
  key: string;
  nodeId: string;
  fieldName: string;
  classType: string;
  nodeTitle?: string;
  valueType: WorkflowValueType;
  semanticType: WorkflowSemanticType;
  defaultValue: unknown;
  confidence: number;
  options?: unknown[];
  min?: number;
  max?: number;
  step?: number;
  mediaControl?: MediaControlBinding;
  showEnableToggle?: boolean;
  submitDefault?: boolean;
  visible?: boolean;
  label?: string;
  displayOrder?: number;
}

export interface MediaControlBinding {
  parameterId: string;
  activeValue: boolean;
  inactiveValue: boolean;
  autoEnableOnReplace: boolean;
  detected: boolean;
}

export interface WorkflowProfileParameter extends WorkflowParameter {
  id: string;
}

export interface WorkflowProfile {
  version: number;
  workflowId: string;
  name: string;
  functionDescription?: string;
  usageInstructions?: string;
  parameters: WorkflowProfileParameter[];
  genericParameters: WorkflowProfileParameter[];
  needsReview: boolean;
  outputs: WorkflowOutput[];
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowOutput {
  id: string;
  nodeId: string;
  classType: string;
  nodeTitle?: string;
  mediaType: "image" | "video" | "audio" | "unknown";
  label: string;
  filenamePrefix?: string;
  saveOutput?: boolean;
  stage: number;
}

export interface WorkflowRecord {
  id: string;
  name: string;
  runningHubWorkflowId: string;
  sourceUrl?: string;
  raw: Record<string, unknown>;
  profile: WorkflowProfile;
  profileVersion: number;
  workflowHash: string;
  createdAt: number;
  updatedAt: number;
}

export interface PortableWorkflowPackage {
  format: "runninghub-runner-workflow";
  schemaVersion: 1;
  exportedAt: string;
  exportedBy: {
    application: "RunningHub Runner";
    version: string;
  };
  workflow: {
    name: string;
    runningHubWorkflowId: string;
    sourceUrl?: string;
    apiJson: Record<string, unknown>;
    workflowHash: string;
  };
  profile: Omit<WorkflowProfile, "workflowId" | "version" | "createdAt" | "updatedAt"> & {
    revision: number;
  };
  compatibility: {
    profileSchemaVersion: 1;
    detectorVersion: 1;
    minimumAppVersion: string;
  };
}

export interface NodeInfo {
  nodeId: string;
  fieldName: string;
  fieldValue: unknown;
}

export interface JobMedia {
  parameterId: string;
  localPath: string;
  uploadedValue?: string;
  uploadedAccountId?: string;
  uploadedAt?: number;
  rawUploadResponse?: unknown;
}

export interface MediaUploadCacheEntry {
  id: string;
  accountId: string;
  fileHash: string;
  fileSize?: number;
  originalPath?: string;
  runningHubValue: string;
  uploadedAt: number;
  lastUsedAt: number;
}

export interface JobSnapshot {
  id: string;
  workflowId: string;
  runningHubWorkflowId: string;
  workflowName: string;
  profileVersion: number;
  profileSnapshot: WorkflowProfile;
  parameters: Record<string, unknown>;
  media: JobMedia[];
  outputDir?: string;
  createdAt: number;
}

export type JobStatus =
  | "PENDING"
  | "ASSIGNED"
  | "UPLOADING"
  | "SUBMITTING"
  | "SUBMIT_UNKNOWN"
  | "REMOTE_QUEUED"
  | "RUNNING"
  | "REMOTE_SUCCESS"
  | "DOWNLOAD_PENDING"
  | "DOWNLOADING"
  | "COMPLETED"
  | "FAILED"
  | "RETRY_WAIT"
  | "CANCELLED";

export type JobErrorCode =
  | "ACCOUNT_INVALID_KEY"
  | "ACCOUNT_NO_BALANCE"
  | "RATE_LIMIT"
  | "CONCURRENCY_LIMIT"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "SERVER_ERROR"
  | "INVALID_PARAMETER"
  | "WORKFLOW_VALIDATION"
  | "MEDIA_INVALID"
  | "UPLOAD_FAILED"
  | "QUERY_FAILED"
  | "TASK_FAILED"
  | "DOWNLOAD_FAILED"
  | "CANCEL_FAILED"
  | "SUBMIT_UNKNOWN"
  | "UNKNOWN";

export type JobPhase = "account" | "upload" | "submit" | "query" | "download" | "cancel" | "recovery";

export interface JobError {
  code: JobErrorCode;
  message: string;
  phase: JobPhase;
  retryable: boolean;
  accountRelated: boolean;
  safeToReassign: boolean;
  httpStatus?: number;
  remoteCode?: string;
  raw?: unknown;
  nodeId?: string;
  nodeName?: string;
  confirmedSubmitFailure?: boolean;
}

export interface JobResultFile {
  url: string;
  type?: string;
  localPath?: string;
  nodeId?: string;
  label?: string;
}

export interface JobResult {
  taskId: string;
  files: JobResultFile[];
  texts: string[];
  usage?: unknown;
  raw: unknown;
}

export interface Job extends JobSnapshot {
  accountId?: string;
  remoteTaskId?: string;
  status: JobStatus;
  outputs?: JobResult;
  rawResult?: unknown;
  lastError?: JobError;
  retryPhase?: JobPhase;
  retryAfter?: number;
  assignedAt?: number;
  submitStartedAt?: number;
  generationStartedAt?: number;
  remoteCompletedAt?: number;
  completedAt?: number;
  updatedAt: number;
}

export interface CreateJobInput {
  workflowId: string;
  parameters: Record<string, unknown>;
  media?: JobMedia[];
  outputDir?: string;
}

export interface PollOptions {
  signal?: AbortSignal;
  maxPollingMs?: number;
  intervalMs?: number;
  onStatus?: (status: string, response: unknown) => void | Promise<void>;
}

export interface RunningHubClientLike {
  accountStatus(): Promise<AccountStatus>;
  uploadMedia(filePath: string): Promise<{ value: string; raw: unknown }>;
  runWorkflow(workflowId: string, nodeInfoList: NodeInfo[]): Promise<string>;
  queryTask(taskId: string): Promise<Record<string, unknown>>;
  pollTask(taskId: string, options?: PollOptions): Promise<JobResult>;
  cancelTask(taskId: string): Promise<void>;
}

export interface LoggerContext {
  jobId?: string;
  accountId?: string;
  remoteTaskId?: string;
  phase?: string;
}
