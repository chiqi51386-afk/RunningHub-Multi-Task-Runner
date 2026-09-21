import type { PortableWorkflowPackage, WorkflowProfile, WorkflowRecord } from "../types.js";
import { parseApiWorkflow } from "./parser.js";
import { repairLowConfidenceSemantics, validateProfile, validateProfileAgainstWorkflow } from "./profiles.js";

export const PORTABLE_WORKFLOW_FORMAT = "runninghub-runner-workflow" as const;
export const PORTABLE_WORKFLOW_SCHEMA_VERSION = 1 as const;

export function isPortableWorkflowPackage(value: unknown): boolean {
  return isObject(value) && value.format === PORTABLE_WORKFLOW_FORMAT;
}

export function createPortableWorkflowPackage(
  workflow: WorkflowRecord,
  applicationVersion = "0.1.0",
): PortableWorkflowPackage {
  const { workflowId: _workflowId, version: _version, createdAt: _createdAt, updatedAt: _updatedAt, ...portableProfile } = structuredClone(workflow.profile);
  return {
    format: PORTABLE_WORKFLOW_FORMAT,
    schemaVersion: PORTABLE_WORKFLOW_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    exportedBy: { application: "RunningHub Runner", version: applicationVersion },
    workflow: {
      name: workflow.name,
      runningHubWorkflowId: workflow.runningHubWorkflowId,
      sourceUrl: workflow.sourceUrl,
      apiJson: structuredClone(workflow.raw),
      workflowHash: workflow.workflowHash,
    },
    profile: { ...portableProfile, revision: workflow.profileVersion },
    compatibility: { profileSchemaVersion: 1, detectorVersion: 1, minimumAppVersion: "0.1.0" },
  };
}

/** Build a distributable workflow without the author's prompt or media filenames. */
export function createCleanPortableWorkflowPackage(
  workflow: WorkflowRecord,
  applicationVersion = "0.1.0",
): PortableWorkflowPackage {
  const clean = structuredClone(workflow);
  const parametersById = new Map(clean.profile.parameters.map(parameter => [parameter.id, parameter]));

  for (const parameter of clean.profile.parameters) {
    if (typeof parameter.defaultValue === "number" && Number.isFinite(parameter.defaultValue) && !Number.isInteger(parameter.defaultValue)) {
      parameter.defaultValue = Number(parameter.defaultValue.toPrecision(12));
      setRawInput(clean.raw, parameter.nodeId, parameter.fieldName, parameter.defaultValue);
    }
    if (!["prompt", "image", "video", "audio"].includes(parameter.semanticType)) continue;
    parameter.defaultValue = "";
    setRawInput(clean.raw, parameter.nodeId, parameter.fieldName, "");

    if (["image", "video", "audio"].includes(parameter.semanticType) && parameter.mediaControl?.parameterId) {
      const control = parametersById.get(parameter.mediaControl.parameterId);
      if (!control) continue;
      control.defaultValue = parameter.mediaControl.inactiveValue;
      setRawInput(clean.raw, control.nodeId, control.fieldName, parameter.mediaControl.inactiveValue);
    }
  }

  clean.profile.genericParameters = clean.profile.parameters.filter(parameter => parameter.semanticType === "unknown");
  clean.workflowHash = parseApiWorkflow(clean.raw).workflowHash;
  return createPortableWorkflowPackage(clean, applicationVersion);
}

export function parsePortableWorkflowPackage(value: unknown): PortableWorkflowPackage {
  if (!isObject(value) || value.format !== PORTABLE_WORKFLOW_FORMAT) {
    throw new Error("该文件不是 RunningHub Runner 工作流配置包。");
  }
  if (value.schemaVersion !== PORTABLE_WORKFLOW_SCHEMA_VERSION) {
    const version = typeof value.schemaVersion === "number" ? value.schemaVersion : "未知";
    throw new Error(`不支持工作流配置包版本 ${version}。请升级 RunningHub Runner 后重试。`);
  }
  if (!isObject(value.workflow) || !isObject(value.profile)) throw new Error("工作流配置包缺少 workflow 或 profile。");
  const workflow = value.workflow;
  const profileValue = value.profile;
  if (typeof workflow.name !== "string" || !workflow.name.trim()) throw new Error("工作流配置包缺少名称。");
  if (typeof workflow.runningHubWorkflowId !== "string" || !/^\d{8,}$/.test(workflow.runningHubWorkflowId.trim())) {
    throw new Error("工作流配置包中的 Workflow ID 无效。");
  }
  if (!isObject(workflow.apiJson)) throw new Error("工作流配置包缺少原始 API JSON。");
  const parsed = parseApiWorkflow(workflow.apiJson);
  if (typeof workflow.workflowHash !== "string" || parsed.workflowHash !== workflow.workflowHash) {
    throw new Error("工作流配置包校验失败：API JSON 与 workflowHash 不一致，文件可能被修改或损坏。");
  }
  if (!Array.isArray(profileValue.parameters) || !Array.isArray(profileValue.outputs)) {
    throw new Error("工作流配置包中的 Profile 结构无效。");
  }
  const revision = positiveInteger(profileValue.revision, 1);
  const now = Date.now();
  const profile: WorkflowProfile = {
    workflowId: "portable-validation",
    version: revision,
    name: typeof profileValue.name === "string" && profileValue.name.trim() ? profileValue.name : workflow.name,
    functionDescription: typeof profileValue.functionDescription === "string" ? profileValue.functionDescription : undefined,
    usageInstructions: typeof profileValue.usageInstructions === "string" ? profileValue.usageInstructions : undefined,
    parameters: structuredClone(profileValue.parameters) as WorkflowProfile["parameters"],
    genericParameters: Array.isArray(profileValue.genericParameters)
      ? structuredClone(profileValue.genericParameters) as WorkflowProfile["genericParameters"]
      : (structuredClone(profileValue.parameters) as WorkflowProfile["parameters"]).filter(item => item.semanticType === "unknown"),
    needsReview: Boolean(profileValue.needsReview),
    outputs: structuredClone(profileValue.outputs) as WorkflowProfile["outputs"],
    createdAt: now,
    updatedAt: now,
  };
  validateProfile(profile);
  validateProfileAgainstWorkflow(profile, parsed.raw);
  return structuredClone(value) as PortableWorkflowPackage;
}

export function materializePortableProfile(
  value: PortableWorkflowPackage,
  workflowId: string,
  version: number,
  now = Date.now(),
  createdAt = now,
): WorkflowProfile {
  const detected = new Map(parseApiWorkflow(value.workflow.apiJson).parameters.map(parameter => [parameter.key, parameter]));
  const parameters = repairLowConfidenceSemantics(structuredClone(value.profile.parameters)).map(parameter => {
    const schema = detected.get(parameter.key);
    return schema?.classType === "ResolutionSelector" && schema.fieldName === "aspect_ratio"
      ? { ...parameter, semanticType: schema.semanticType, valueType: schema.valueType, defaultValue: schema.defaultValue,
          submitDefault: schema.submitDefault, options: schema.options, confidence: 1 }
      : parameter;
  });
  const profile: WorkflowProfile = {
    workflowId,
    version,
    name: value.workflow.name,
    functionDescription: value.profile.functionDescription,
    usageInstructions: value.profile.usageInstructions,
    parameters,
    genericParameters: parameters.filter(item => item.semanticType === "unknown"),
    needsReview: value.profile.needsReview,
    outputs: structuredClone(value.profile.outputs),
    createdAt,
    updatedAt: now,
  };
  validateProfile(profile);
  validateProfileAgainstWorkflow(profile, value.workflow.apiJson);
  return profile;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function isObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function setRawInput(raw: Record<string, unknown>, nodeId: string, fieldName: string, value: unknown): void {
  const node = raw[nodeId];
  if (!isObject(node) || !isObject(node.inputs) || !(fieldName in node.inputs)) return;
  node.inputs[fieldName] = value;
}
