import type { AccountState, WorkflowValueType, WorkflowSemanticType, JobStatus, MediaControlBinding } from "../../src/core/types.js";
export type { AccountState, WorkflowValueType, WorkflowSemanticType, JobStatus, MediaControlBinding } from "../../src/core/types.js";
export type ViewId = "overview" | "accounts" | "workflows" | "create" | "jobs";



export interface AccountView {
  maxConcurrency?: number;
  activeJobCount?: number;
  externalTaskCount?: number;
  id: string;
  label: string;
  state: AccountState;
  coins?: string;
  apiType?: string;
  enabled: boolean;
  lastCheckedAt?: number;
  currentJobId?: string;
  remoteTaskCount?: number;
}

export interface WorkflowView {
  builtIn?: boolean;
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
  referenceIndex?: number;
  mappingIssue?: string;
}





export interface JobView {
  displayName?: string;
  taskName?: string;
  optimizationTrace?: {model:string;skillName?:string;skillHash?:string;originalText?:string;firstStageText?:string;finalText?:string};
  cancelRequestedAt?: number;
  submission?: { recordedAt: number; workflowId: string; nodeInfoList: Array<{ nodeId: string; fieldName: string; fieldValue: unknown }>; instanceType?: "plus" };
  id: string;
  workflowName: string;
  status: JobStatus;
  instanceType: "default" | "plus";
  accountLabel?: string;
  remoteTaskId?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  generationStartedAt?: number;
  generationCompletedAt?: number;
  outputType?: string;
  error?: string;
  errorDetail?: JobErrorView;
  texts?: string[];
  stageLabel?: string;
  retryPhase?: string;
  outputs?: JobOutputView[];
  inputs?: JobInputSnapshotView;
}

export interface JobErrorView {
  code: string;
  message: string;
  phase: string;
  remoteCode?: string;
  retryable: boolean;
  nodeId?: string;
  nodeName?: string;
}

export interface JobInputSnapshotView {
  taskName?: string;
  production?: { groupId: string; segmentIndex: number };
  workflowId: string;
  profileVersion: number;
  instanceType: "default" | "plus";
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
  taskName?: string;
  /** Legacy test-version field. */
  geminiOptimization?: boolean;
  promptOptimizationEnabled?: boolean;
  workflowInputs?: Record<string, Record<string, unknown>>;
  commonInputs?: { duration?: unknown; aspect_ratio?: unknown };
  production?: { groupId: string; segmentIndex: number };
  workflowSnapshot?: WorkflowView;
  workflowId: string;
  profileVersion: number;
  instanceType: "default" | "plus";
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
