export type ViewId = "overview" | "accounts" | "workflows" | "create" | "jobs";

export type AccountState = "UNCHECKED" | "SECRET_UNREADABLE" | "IDLE" | "BUSY" | "REMOTE_BUSY" | "CHECKING" | "COOLDOWN" | "NO_BALANCE" | "INVALID_KEY" | "TEMP_UNAVAILABLE" | "DISABLED";

export interface AccountView {
  id: string;
  label: string;
  state: AccountState;
  coins?: string;
  apiType?: string;
  enabled: boolean;
  lastCheckedAt?: number;
  currentJobId?: string;
}

export interface WorkflowView {
  id: string;
  name: string;
  functionDescription?: string;
  usageInstructions?: string;
  runningHubWorkflowId: string;
  sourceUrl?: string;
  parameterCount: number;
  needsReview: boolean;
  profileVersion: number;
  updatedAt: number;
  parameters: WorkflowParameterView[];
  outputs?: WorkflowOutputView[];
}

export interface WorkflowOutputView {
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

export type WorkflowValueType = "string" | "integer" | "number" | "boolean" | "image" | "video" | "audio" | "select";

export type WorkflowSemanticType =
  | "prompt" | "negative_prompt" | "image" | "video" | "audio" | "duration"
  | "fps" | "frames" | "width" | "height" | "aspect_ratio" | "resolution" | "resolution_multiple" | "upscale_factor"
  | "seed" | "steps" | "cfg" | "sampler" | "scheduler" | "denoise"
  | "model" | "lora" | "unknown";

export interface WorkflowParameterView {
  id: string;
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

export type JobStatus =
  | "PENDING" | "ASSIGNED" | "UPLOADING" | "SUBMITTING" | "SUBMIT_UNKNOWN"
  | "REMOTE_QUEUED" | "RUNNING" | "REMOTE_SUCCESS" | "DOWNLOAD_PENDING"
  | "DOWNLOADING" | "COMPLETED" | "FAILED" | "RETRY_WAIT" | "CANCELLED";

export interface JobView {
  id: string;
  workflowName: string;
  status: JobStatus;
  accountLabel?: string;
  remoteTaskId?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  generationStartedAt?: number;
  generationCompletedAt?: number;
  progress: number;
  outputType?: string;
  error?: string;
  outputs?: JobOutputView[];
  inputs?: JobInputSnapshotView;
}

export interface JobInputSnapshotView {
  workflowId: string;
  profileVersion: number;
  parameters: JobInputParameterView[];
  media: JobInputMediaView[];
}

export interface JobInputParameterView {
  id: string;
  key: string;
  label: string;
  semanticType: WorkflowSemanticType;
  value: unknown;
}

export interface JobInputMediaView {
  parameterId: string;
  key: string;
  label: string;
  type: "image" | "video" | "audio";
  mode: "default" | "replace" | "clear";
  fileName?: string;
  localPath?: string;
  previewUrl?: string;
}

export interface JobOutputView {
  url: string;
  previewUrl?: string;
  localPath?: string;
  type?: string;
  nodeId?: string;
  label?: string;
  stage?: number;
}

export interface CreateJobDraft {
  workflowId: string;
  profileVersion: number;
  parameterValues: Record<string, unknown>;
  mediaOverrides: Record<string, MediaParameterDraft>;
}

export interface MediaParameterDraft {
  enabled: boolean;
  mode: "replace" | "clear";
  file?: File;
  localPath?: string;
  fileName?: string;
  previewUrl?: string;
}
